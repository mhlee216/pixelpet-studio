"""
픽셀 에디터 로컬 서버
실행: python3 server.py (또는 bash run.sh)
브라우저에서 http://localhost:8000 접속
"""

import errno
import hashlib
import http.server
import json
import os
import re
import secrets
import shutil
import sys

PORT = 8000
DIR = os.path.dirname(os.path.abspath(__file__))

# env.config 파일 로드
_env_path = os.path.join(DIR, "env.config")
if os.path.isfile(_env_path):
    with open(_env_path) as _f:
        for _line in _f:
            _line = _line.strip()
            if _line and not _line.startswith("#") and "=" in _line:
                _k, _v = _line.split("=", 1)
                os.environ.setdefault(_k.strip(), _v.strip())


# ─── 비밀번호 해싱 ───
_PBKDF2_ITER = 200000

def _hash_pw(pw):
    """pbkdf2_sha256 + random salt. 포맷: pbkdf2_sha256$<iter>$<salt_hex>$<hash_hex>"""
    salt = secrets.token_bytes(16)
    h = hashlib.pbkdf2_hmac("sha256", pw.encode(), salt, _PBKDF2_ITER)
    return f"pbkdf2_sha256${_PBKDF2_ITER}${salt.hex()}${h.hex()}"


def _verify_pw(pw, stored):
    """신형(pbkdf2_sha256) + 구형(plain sha256 64hex) 둘 다 수용."""
    if not stored:
        return False
    if stored.startswith("pbkdf2_sha256$"):
        try:
            _, iters, salt_hex, hash_hex = stored.split("$")
            h = hashlib.pbkdf2_hmac("sha256", pw.encode(), bytes.fromhex(salt_hex), int(iters))
            return secrets.compare_digest(h.hex(), hash_hex)
        except Exception:
            return False
    # legacy: 평문 SHA-256 (64 hex) — 매치 시 호출자가 pbkdf2로 자동 업그레이드
    if len(stored) == 64 and all(c in "0123456789abcdef" for c in stored):
        return secrets.compare_digest(stored, hashlib.sha256(pw.encode()).hexdigest())
    return False


def _is_legacy_hash(stored):
    return bool(stored) and not stored.startswith("pbkdf2_sha256$")


# ─── char_id 검증 (path traversal 방어) ───
_CHAR_ID_RE = re.compile(r"^[\w\-]+$")

def _safe_char_id(char_id):
    """영문/숫자/_/- 만, 길이 1~64."""
    return isinstance(char_id, str) and 1 <= len(char_id) <= 64 and bool(_CHAR_ID_RE.match(char_id))


# ─── 사용자 / 세션 ───
USERS = {
    "Master": {"password": _hash_pw(os.environ.get("MASTER_PW", "0000")),
               "role": "master", "memo": "", "pw_changed": False},
}
for _i in range(1, 11):
    USERS[f"Editor {_i}"] = {"password": _hash_pw("0000"), "role": "user",
                             "memo": "", "pw_changed": False}

SESSIONS = {}  # token -> {"username": ..., "role": ...}


def _atomic_write_json(path, data):
    """JSON 원자적 쓰기 — 도중에 죽어도 원본 파일 손상 없음."""
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=2)
    os.replace(tmp, path)


def save_users():
    """사용자 정보를 users.json에 저장."""
    path = os.path.join(DIR, "users.json")
    data = {}
    for name, info in USERS.items():
        data[name] = {
            "password": info["password"],
            "role": info["role"],
            "memo": info.get("memo", ""),
            "pw_changed": info.get("pw_changed", False),
        }
    _atomic_write_json(path, data)


def load_users():
    """users.json에서 사용자 정보를 로드. MASTER_PW 환경변수가 있으면 우선 적용."""
    path = os.path.join(DIR, "users.json")
    if os.path.exists(path):
        with open(path, "r", encoding="utf-8") as f:
            data = json.load(f)
        USERS.clear()
        USERS.update(data)
        # 구 파일 마이그레이션: pw_changed 필드 없으면 추론
        # (legacy sha256 해시가 기본값 "0000"과 다르면 변경된 것으로 간주)
        _legacy_default = hashlib.sha256("0000".encode()).hexdigest()
        for _u in USERS.values():
            _u.setdefault("memo", "")
            if "pw_changed" not in _u:
                _stored = _u.get("password", "")
                _u["pw_changed"] = (
                    not _stored.startswith("pbkdf2_sha256$")
                    and _stored != _legacy_default
                )
    # env.config의 MASTER_PW가 항상 우선 (env.config 수정 → 재시작이 곧바로 반영되도록)
    pw = os.environ.get("MASTER_PW")
    if pw and "Master" in USERS:
        USERS["Master"]["password"] = _hash_pw(pw)


def authenticate(username, password):
    user = USERS.get(username)
    if user and _verify_pw(password, user["password"]):
        # 구형 sha256 해시 → 즉시 pbkdf2로 업그레이드 저장
        if _is_legacy_hash(user["password"]):
            user["password"] = _hash_pw(password)
            save_users()
        token = secrets.token_urlsafe(32)
        SESSIONS[token] = {"username": username, "role": user["role"]}
        return token
    return None


def get_session(handler):
    """쿠키에서 세션 정보를 반환. 없으면 None."""
    cookie = handler.headers.get("Cookie", "")
    for part in cookie.split(";"):
        part = part.strip()
        if part.startswith("session="):
            token = part[8:]
            return SESSIONS.get(token)
    return None

FRAME_NAMES = [
    "IDLE_0", "IDLE_1",
    "WALK_0", "WALK_1",
    "SIT_0", "SIT_1",
    "SLEEP_0", "SLEEP_1",
]


DEFAULT_ANIM_SPEEDS = {
    "idle": 500, "walk": 500, "run": 150,
    "sit": 500, "sleep": 1000,
}


CHARS_DIR = os.path.join(DIR, "characters")


# ─── 캐릭터 관리 ───

def list_characters(session=None):
    """캐릭터 목록 반환. Master는 전체, User는 자신의 것 + 승인된 전체."""
    os.makedirs(CHARS_DIR, exist_ok=True)
    chars = []
    for d in sorted(os.listdir(CHARS_DIR)):
        cp = os.path.join(CHARS_DIR, d, "character.json")
        if not os.path.isfile(cp):
            continue
        try:
            with open(cp, "r", encoding="utf-8") as f:
                data = json.load(f)
        except (json.JSONDecodeError, OSError) as e:
            print(f"⚠️  손상된 캐릭터 파일 skip: {d} ({e})")
            continue
        owner = data.get("owner", "Master")
        status = data.get("status", "draft")
        if session and session["role"] != "master":
            if owner != session["username"] and status != "approved":
                continue
        idle0 = data.get("frames", {}).get("IDLE_0", [])
        chars.append({
            "id": d,
            "name": data.get("name", d),
            "owner": owner,
            "status": data.get("status", "submitted"),
            "idle0": idle0,
        })
    return chars


def can_access_character(char_id, session):
    """읽기 권한 — view/load/template 용. 승인된 건 누구나 볼 수 있음."""
    if not session:
        return False
    if session["role"] == "master":
        return True
    data = load_character(char_id)
    if not data:
        return False
    if data.get("status") == "approved":
        return True
    return data.get("owner", "Master") == session["username"]


def can_modify_character(char_id, session):
    """쓰기 권한. 승인된 건 master만 (owner도 X — unapprove 후 재편집)."""
    if not session:
        return False
    data = load_character(char_id)
    if not data:
        return False
    if data.get("status") == "approved":
        return session["role"] == "master"
    if session["role"] == "master":
        return True
    return data.get("owner", "Master") == session["username"]


def name_exists(name, exclude_id=None):
    """캐릭터 이름 중복 검사 (완전 일치). exclude_id는 제외."""
    os.makedirs(CHARS_DIR, exist_ok=True)
    for d in os.listdir(CHARS_DIR):
        if d == exclude_id:
            continue
        cp = os.path.join(CHARS_DIR, d, "character.json")
        if not os.path.isfile(cp):
            continue
        try:
            with open(cp, "r", encoding="utf-8") as f:
                data = json.load(f)
        except (json.JSONDecodeError, OSError):
            continue
        if data.get("name") == name:
            return True
    return False


def create_character(name, owner="Master", template_id=None):
    """새 캐릭터 폴더/JSON 생성, ID 반환."""
    # 충돌 가능성 매우 낮지만(1/4억) 안전하게 unique 보장
    while True:
        char_id = secrets.token_hex(4)  # 8 hex chars, uuid4[:8]과 동일 포맷
        char_dir = os.path.join(CHARS_DIR, char_id)
        if not os.path.exists(char_dir):
            break
    os.makedirs(char_dir)

    template = None
    if template_id:
        tpl = load_character(template_id)
        if tpl and tpl.get("status") == "approved":
            template = tpl

    if template:
        frames_data = template["frames"]
        speeds = template.get("anim_speeds", dict(DEFAULT_ANIM_SPEEDS))
    else:
        frames_data = {fn: [["T"] * 20 for _ in range(14)] for fn in FRAME_NAMES}
        speeds = dict(DEFAULT_ANIM_SPEEDS)

    data = {
        "name": name,
        "owner": owner,
        "status": "draft",
        "template_id": template_id if template else None,
        "frames": frames_data,
        "anim_speeds": speeds,
        "dialogues": {
            "idle": ["(심심해)", "(뭐 하지)", "집사야 뭐해", "코딩하냐?"],
            "walk": ["산책?", "날씨 좋다", "배고파", "지나갈게"],
            "sit": ["여기 좋다", "편하다", "에러 있는데", "(식빵 아님)"],
            "sleep": ["드렁슨 드르렁슨", "(에러 생각)", "푸데~푸데~"],
            "feed": ["맛있다", "냠냠", "쩝쩝"],
            "pet": ["츄르 줘", "뭐가 고민인데", "잘하자"],
            "drag": ["건들지마", "냥냥펀치 맞을래?"],
        },
    }
    _atomic_write_json(os.path.join(char_dir, "character.json"), data)
    return char_id


def load_character(char_id):
    """캐릭터 JSON 로드."""
    cp = os.path.join(CHARS_DIR, char_id, "character.json")
    if not os.path.isfile(cp):
        return None
    with open(cp, "r", encoding="utf-8") as f:
        return json.load(f)


def save_character(char_id, frames_data, speeds=None, name=None,
                   allow_flip=None, dialogues=None, expected_mtime=None):
    """캐릭터 JSON 저장. expected_mtime이 현재 mtime과 다르면 'conflict' 반환."""
    cp = os.path.join(CHARS_DIR, char_id, "character.json")
    if not os.path.isfile(cp):
        return False
    if expected_mtime is not None:
        current_mtime = os.path.getmtime(cp)
        # 0.01초 허용 오차 (파일시스템 정밀도 차이)
        if abs(current_mtime - expected_mtime) > 0.01:
            return 'conflict'
    with open(cp, "r", encoding="utf-8") as f:
        data = json.load(f)
    data["frames"] = frames_data
    if speeds:
        data["anim_speeds"] = speeds
    if name is not None:
        data["name"] = name
    if allow_flip is not None:
        data["allow_flip"] = allow_flip
    if dialogues is not None:
        data["dialogues"] = dialogues
    _atomic_write_json(cp, data)
    return True


def rename_character(char_id, new_name):
    """캐릭터 이름 변경."""
    cp = os.path.join(CHARS_DIR, char_id, "character.json")
    if not os.path.isfile(cp):
        return False
    with open(cp, "r", encoding="utf-8") as f:
        data = json.load(f)
    data["name"] = new_name
    _atomic_write_json(cp, data)
    return True


def rename_character_folder(char_id, new_id):
    """캐릭터 폴더명 변경. 새 ID 반환."""
    new_id = new_id.strip()
    if not _safe_char_id(new_id):
        return None  # 영문/숫자/_/-만, 길이 1~64
    old_dir = os.path.join(CHARS_DIR, char_id)
    new_dir = os.path.join(CHARS_DIR, new_id)
    if not os.path.isdir(old_dir):
        return None
    if os.path.exists(new_dir):
        return None  # 이미 존재
    os.rename(old_dir, new_dir)
    return new_id


def delete_character(char_id):
    """캐릭터 폴더 삭제."""
    char_dir = os.path.join(CHARS_DIR, char_id)
    if os.path.isdir(char_dir):
        shutil.rmtree(char_dir)
        return True
    return False


class Handler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=DIR, **kwargs)

    def _redirect(self, location):
        self.send_response(302)
        self.send_header("Location", location)
        self.end_headers()

    def _json_response(self, code, data):
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.end_headers()
        self.wfile.write(json.dumps(data).encode())

    def do_GET(self):
        if self.path == "/" or self.path == "":
            session = get_session(self)
            if session:
                return self._redirect("/editor.html")
            self.path = "/studio/login.html"
        elif self.path == "/editor.html":
            session = get_session(self)
            if not session:
                return self._redirect("/")
            self.path = "/studio/editor.html"
        elif self.path == "/characters":
            session = get_session(self)
            if not session:
                return self._json_response(401, {"error": "unauthorized"})
            return self._json_response(200, list_characters(session))
        elif self.path.startswith("/character/") and self.path.endswith("/load"):
            session = get_session(self)
            if not session:
                return self._json_response(401, {"error": "unauthorized"})
            char_id = self.path.split("/")[2]
            if not _safe_char_id(char_id):
                return self._json_response(400, {"error": "invalid character id"})
            if not can_access_character(char_id, session):
                return self._json_response(403, {"error": "forbidden"})
            data = load_character(char_id)
            if data:
                # 동시 편집 충돌 감지용 mtime 포함
                cp = os.path.join(CHARS_DIR, char_id, "character.json")
                data['_mtime'] = os.path.getmtime(cp)
                return self._json_response(200, data)
            return self._json_response(404, {"error": "not found"})
        elif self.path == "/api/pets":
            # 공개 API: 승인된 캐릭터 전체 데이터 (인증 불필요)
            os.makedirs(CHARS_DIR, exist_ok=True)
            pets = []
            for d in sorted(os.listdir(CHARS_DIR)):
                cp = os.path.join(CHARS_DIR, d, "character.json")
                if not os.path.isfile(cp):
                    continue
                try:
                    with open(cp, "r", encoding="utf-8") as f:
                        data = json.load(f)
                except (json.JSONDecodeError, OSError) as e:
                    print(f"⚠️  손상된 캐릭터 파일 skip: {d} ({e})")
                    continue
                if data.get("status") != "approved":
                    continue
                pets.append({
                    "id": d,
                    "name": data.get("name", d),
                    "frames": data.get("frames", {}),
                    "anim_speeds": data.get("anim_speeds", {}),
                    "allow_flip": data.get("allow_flip", True),
                    "dialogues": data.get("dialogues", {}),
                })
            return self._json_response(200, pets)
        elif self.path == "/me":
            session = get_session(self)
            if not session:
                return self._json_response(401, {"error": "unauthorized"})
            return self._json_response(200, session)
        elif self.path == "/logout":
            cookie = self.headers.get("Cookie", "")
            for part in cookie.split(";"):
                part = part.strip()
                if part.startswith("session="):
                    token = part[8:]
                    SESSIONS.pop(token, None)
            self.send_response(302)
            self.send_header("Location", "/")
            self.send_header("Set-Cookie", "session=; Max-Age=0; Path=/")
            self.end_headers()
            return
        # 정적 fallthrough는 login/editor HTML 두 개만 허용.
        # 이걸 제한 안 하면 SimpleHTTPRequestHandler가 repo 전체를 서빙 →
        # /env.config(MASTER_PW 평문), /users.json, /server.py, 비승인 캐릭터 JSON 노출됨.
        if self.path not in ("/studio/login.html", "/studio/editor.html"):
            self.send_response(404)
            self.end_headers()
            return
        return super().do_GET()

    def do_POST(self):
        if self.path == "/login":
            length = int(self.headers.get("Content-Length", 0))
            body = self.rfile.read(length)
            try:
                data = json.loads(body)
                token = authenticate(data.get("username", ""),
                                     data.get("password", ""))
                if token:
                    self.send_response(200)
                    self.send_header("Content-Type", "application/json")
                    self.send_header("Set-Cookie",
                                     f"session={token}; Path=/; HttpOnly; SameSite=Strict")
                    self.end_headers()
                    self.wfile.write(json.dumps({"ok": True}).encode())
                    print(f"🔑 로그인: {data.get('username')}")
                else:
                    self._json_response(401, {"error": "invalid credentials"})
            except Exception:
                self._json_response(400, {"error": "bad request"})
            return

        if self.path == "/character/create":
            session = get_session(self)
            if not session:
                return self._json_response(401, {"error": "unauthorized"})
            length = int(self.headers.get("Content-Length", 0))
            body = self.rfile.read(length)
            try:
                data = json.loads(body)
                name = data.get("name", "").strip()
                if not name:
                    return self._json_response(400, {"error": "name required"})
                if name_exists(name):
                    return self._json_response(409, {"error": "duplicate", "message": "이미 존재하는 이름입니다"})
                template_id = data.get("template_id")
                if template_id and not _safe_char_id(template_id):
                    return self._json_response(400, {"error": "invalid template id"})
                # 템플릿은 read 권한이 있어야 사용 가능 (owner 본인 + 승인된 것)
                if template_id and not can_access_character(template_id, session):
                    return self._json_response(403, {"error": "template forbidden"})
                char_id = create_character(name, owner=session["username"],
                                           template_id=template_id)
                print(f"🎨 캐릭터 생성 [{name}] by {session['username']}")
                return self._json_response(200, {"ok": True, "id": char_id})
            except Exception:
                return self._json_response(400, {"error": "bad request"})

        if self.path.startswith("/character/") and self.path.endswith("/save"):
            session = get_session(self)
            if not session:
                return self._json_response(401, {"error": "unauthorized"})
            char_id = self.path.split("/")[2]
            if not _safe_char_id(char_id):
                return self._json_response(400, {"error": "invalid character id"})
            if not can_modify_character(char_id, session):
                return self._json_response(403, {"error": "forbidden"})
            length = int(self.headers.get("Content-Length", 0))
            body = self.rfile.read(length)
            try:
                data = json.loads(body)
                ok = save_character(
                    char_id,
                    data.get("frames", {}),
                    data.get("speeds"),
                    data.get("name"),
                    data.get("allow_flip"),
                    data.get("dialogues"),
                    expected_mtime=data.get("expected_mtime"),
                )
                if ok == 'conflict':
                    return self._json_response(409, {
                        "error": "conflict",
                        "message": "다른 사람이 먼저 저장했습니다. 새로고침 후 다시 편집하세요."
                    })
                if ok:
                    print(f"✅ 캐릭터 저장 [{char_id}] by {session['username']}")
                    cp = os.path.join(CHARS_DIR, char_id, "character.json")
                    return self._json_response(200, {"ok": True, "mtime": os.path.getmtime(cp)})
                return self._json_response(404, {"error": "not found"})
            except Exception as e:
                return self._json_response(500, {"error": str(e)})

        if self.path.startswith("/character/") and self.path.endswith("/submit"):
            session = get_session(self)
            if not session:
                return self._json_response(401, {"error": "unauthorized"})
            char_id = self.path.split("/")[2]
            if not _safe_char_id(char_id):
                return self._json_response(400, {"error": "invalid character id"})
            if not can_modify_character(char_id, session):
                return self._json_response(403, {"error": "forbidden"})
            cp = os.path.join(CHARS_DIR, char_id, "character.json")
            if not os.path.isfile(cp):
                return self._json_response(404, {"error": "not found"})
            with open(cp, "r", encoding="utf-8") as f:
                data = json.load(f)
            data["status"] = "submitted"
            _atomic_write_json(cp, data)
            print(f"📨 캐릭터 제출 [{data.get('name')}] by {session['username']}")
            return self._json_response(200, {"ok": True})

        if self.path.startswith("/character/") and self.path.endswith("/unsubmit"):
            session = get_session(self)
            if not session:
                return self._json_response(401, {"error": "unauthorized"})
            char_id = self.path.split("/")[2]
            if not _safe_char_id(char_id):
                return self._json_response(400, {"error": "invalid character id"})
            if not can_modify_character(char_id, session):
                return self._json_response(403, {"error": "forbidden"})
            cp = os.path.join(CHARS_DIR, char_id, "character.json")
            if not os.path.isfile(cp):
                return self._json_response(404, {"error": "not found"})
            with open(cp, "r", encoding="utf-8") as f:
                data = json.load(f)
            data["status"] = "draft"
            _atomic_write_json(cp, data)
            print(f"⏪ 제출 취소 [{data.get('name')}] by {session['username']}")
            return self._json_response(200, {"ok": True})

        if self.path.startswith("/character/") and self.path.endswith("/rename"):
            session = get_session(self)
            if not session:
                return self._json_response(401, {"error": "unauthorized"})
            char_id = self.path.split("/")[2]
            if not _safe_char_id(char_id):
                return self._json_response(400, {"error": "invalid character id"})
            if not can_modify_character(char_id, session):
                return self._json_response(403, {"error": "forbidden"})
            length = int(self.headers.get("Content-Length", 0))
            body = self.rfile.read(length)
            try:
                data = json.loads(body)
                name = data.get("name", "").strip()
                if not name:
                    return self._json_response(400, {"error": "name required"})
                if name_exists(name, exclude_id=char_id):
                    return self._json_response(409, {"error": "duplicate", "message": "이미 존재하는 이름입니다"})
                if rename_character(char_id, name):
                    return self._json_response(200, {"ok": True})
                return self._json_response(404, {"error": "not found"})
            except Exception:
                return self._json_response(400, {"error": "bad request"})

        if self.path.startswith("/character/") and self.path.endswith("/rename-folder"):
            session = get_session(self)
            if not session or session["role"] != "master":
                return self._json_response(403, {"error": "master only"})
            char_id = self.path.split("/")[2]
            if not _safe_char_id(char_id):
                return self._json_response(400, {"error": "invalid character id"})
            length = int(self.headers.get("Content-Length", 0))
            body = self.rfile.read(length)
            try:
                data = json.loads(body)
                new_id = data.get("folder", "").strip()
                if not new_id:
                    return self._json_response(400,
                                               {"error": "folder name required"})
                result = rename_character_folder(char_id, new_id)
                if result:
                    print(f"📁 폴더 변경 [{char_id} → {result}] "
                          f"by {session['username']}")
                    return self._json_response(200,
                                               {"ok": True, "id": result})
                return self._json_response(400,
                                           {"error": "invalid name or already exists"})
            except Exception:
                return self._json_response(400, {"error": "bad request"})

        if self.path.startswith("/character/") and self.path.endswith("/unapprove"):
            session = get_session(self)
            if not session or session["role"] != "master":
                return self._json_response(403, {"error": "master only"})
            char_id = self.path.split("/")[2]
            if not _safe_char_id(char_id):
                return self._json_response(400, {"error": "invalid character id"})
            cp = os.path.join(CHARS_DIR, char_id, "character.json")
            if not os.path.isfile(cp):
                return self._json_response(404, {"error": "not found"})
            with open(cp, "r", encoding="utf-8") as f:
                data = json.load(f)
            data["status"] = "submitted"
            _atomic_write_json(cp, data)
            print(f"⏪ 승인 취소 [{data.get('name')}] by {session['username']}")
            return self._json_response(200, {"ok": True})

        if self.path.startswith("/character/") and self.path.endswith("/delete"):
            session = get_session(self)
            if not session:
                return self._json_response(401, {"error": "unauthorized"})
            char_id = self.path.split("/")[2]
            if not _safe_char_id(char_id):
                return self._json_response(400, {"error": "invalid character id"})
            if not can_modify_character(char_id, session):
                return self._json_response(403, {"error": "forbidden"})
            if delete_character(char_id):
                print(f"🗑️ 캐릭터 삭제 [{char_id}] by {session['username']}")
                return self._json_response(200, {"ok": True})
            return self._json_response(404, {"error": "not found"})

        if self.path.startswith("/character/") and self.path.endswith("/approve"):
            session = get_session(self)
            if not session or session["role"] != "master":
                return self._json_response(403, {"error": "master only"})
            char_id = self.path.split("/")[2]
            if not _safe_char_id(char_id):
                return self._json_response(400, {"error": "invalid character id"})
            char_data = load_character(char_id)
            if not char_data:
                return self._json_response(404, {"error": "not found"})
            try:
                # 상태를 승인으로 변경
                cp = os.path.join(CHARS_DIR, char_id, "character.json")
                char_data["status"] = "approved"
                _atomic_write_json(cp, char_data)
                print(f"✅ 캐릭터 승인 [{char_data.get('name')}] "
                      f"by {session['username']}")
                return self._json_response(200, {"ok": True})
            except Exception as e:
                return self._json_response(500, {"error": str(e)})

        if self.path == "/set-password":
            session = get_session(self)
            if not session or session["role"] != "master":
                return self._json_response(403, {"error": "master only"})
            length = int(self.headers.get("Content-Length", 0))
            body = self.rfile.read(length)
            try:
                data = json.loads(body)
                target = data.get("username", "")
                new_pw = data.get("password", "")
                if target not in USERS:
                    return self._json_response(404,
                                               {"error": "user not found"})
                if not new_pw or len(new_pw) < 4:
                    return self._json_response(400,
                                               {"error": "password too short"})
                USERS[target]["password"] = _hash_pw(new_pw)
                USERS[target]["pw_changed"] = True
                save_users()
                print(f"🔐 비밀번호 변경 [{target}] by {session['username']}")
                return self._json_response(200, {"ok": True})
            except Exception:
                return self._json_response(400, {"error": "bad request"})

        if self.path == "/set-memo":
            session = get_session(self)
            if not session or session["role"] != "master":
                return self._json_response(403, {"error": "master only"})
            length = int(self.headers.get("Content-Length", 0))
            body = self.rfile.read(length)
            try:
                data = json.loads(body)
                target = data.get("username", "")
                memo = data.get("memo", "")
                if target not in USERS:
                    return self._json_response(404, {"error": "user not found"})
                USERS[target]["memo"] = memo
                save_users()
                return self._json_response(200, {"ok": True})
            except Exception:
                return self._json_response(400, {"error": "bad request"})

        if self.path == "/users":
            session = get_session(self)
            if not session or session["role"] != "master":
                return self._json_response(403, {"error": "master only"})
            length = int(self.headers.get("Content-Length", 0))
            body = self.rfile.read(length)
            # 각 User별 캐릭터 현황 집계
            all_chars = list_characters()
            user_info = []
            for uname, udata in USERS.items():
                pw_changed = udata.get("pw_changed", False)
                chars = [c for c in all_chars if c["owner"] == uname]
                submitted = sum(1 for c in chars if c["status"] == "submitted")
                approved = sum(1 for c in chars if c["status"] == "approved")
                draft = sum(1 for c in chars if c["status"] == "draft")
                user_info.append({
                    "username": uname,
                    "role": udata["role"],
                    "pw_changed": pw_changed,
                    "memo": udata.get("memo", ""),
                    "chars_draft": draft,
                    "chars_submitted": submitted,
                    "chars_approved": approved,
                })
            return self._json_response(200, {"users": user_info})

        self.send_response(404)
        self.end_headers()

    def do_OPTIONS(self):
        self.send_response(200)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.end_headers()


if __name__ == "__main__":
    load_users()
    if not os.path.exists(os.path.join(DIR, "users.json")):
        save_users()  # 초기 users.json 생성
    print(f"🐱 픽셀 에디터 서버 시작: http://localhost:{PORT}")
    print(f"   등록된 사용자: {', '.join(USERS.keys())}")
    print("   Ctrl+C로 종료")
    try:
        server = http.server.HTTPServer(("", PORT), Handler)
    except OSError as e:
        if e.errno == errno.EADDRINUSE:
            print(f"❌ 포트 {PORT}이(가) 이미 사용 중입니다. 기존 서버를 종료하고 다시 실행하세요.")
            print(f"   확인: ss -tln | grep :{PORT}   |   종료: kill $(lsof -t -i :{PORT})")
            sys.exit(1)
        raise
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\n서버 종료")
