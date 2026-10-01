#!/usr/bin/env python3
"""Write LOGIN/PASSWORD to O_EXCL 0600 file. Never prints values."""
import os
import sys

login = os.environ.get("PIPOD_ACCEPTANCE_LOGIN", "")
password = os.environ.get("PIPOD_ACCEPTANCE_PASSWORD", "")
if not login or not password:
    print("write_creds: missing LOGIN or PASSWORD env", flush=True)
    sys.exit(1)
if any(c in login or c in password for c in "\n\r\0"):
    print("write_creds: rejected control byte", flush=True)
    sys.exit(1)
path = sys.argv[1]
fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
try:
    os.write(fd, f"LOGIN={login}\nPASSWORD={password}\n".encode())
    os.fsync(fd)
finally:
    os.close(fd)
print("write_creds: ok", flush=True)
