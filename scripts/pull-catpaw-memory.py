#!/usr/bin/env python3
"""Pull a CatPaw remote-memory snapshot into an IKB staging directory.

The plugin credential is intentionally read from the environment.  The SSO
access token is always obtained through the shared token_cache.py helper.
"""

import argparse
import base64
import collections
import hashlib
import json
import os
import secrets
import sys
import tempfile
import time
from datetime import datetime, timezone
from pathlib import Path

import requests
from Crypto.Cipher import AES


DEFAULT_API_BASE = "https://mcopilot-emb.sankuai.com"
DEFAULT_AUDIENCE = "c7fb060330"
DEFAULT_TOKEN_CACHE = Path.home() / ".claude/skills/flight-pipeline-automated-integration-test/scripts"
PLUGIN_VERSION = "1.0.4"
PLUGIN_SOURCE = "CatPawDesk"


def access_token(audience: str) -> str:
    sys.path.insert(0, str(DEFAULT_TOKEN_CACHE))
    from token_cache import get_sso_token

    return get_sso_token(audience)


def headers(plugin_auth: str, token: str, mis: str) -> dict[str, str]:
    timestamp = str(int(time.time() * 1000))
    nonce = secrets.token_bytes(12)
    cipher = AES.new(hashlib.sha256(plugin_auth.encode()).digest(), AES.MODE_GCM, nonce=nonce)
    ciphertext, tag = cipher.encrypt_and_digest(f"{mis}|{timestamp}|{PLUGIN_SOURCE}|{PLUGIN_VERSION}".encode())
    return {
        "Content-Type": "application/json",
        "Authorization": f"Bearer {plugin_auth}",
        "X-Plugin-Version": PLUGIN_VERSION,
        "X-Timestamp": timestamp,
        "X-Plugin-Token": base64.b64encode(nonce + ciphertext + tag).decode(),
        "access-token": token,
    }


def pull(api_base: str, token: str, plugin_auth: str, mis: str, page_size: int) -> tuple[list[dict], int, int]:
    items: list[dict] = []
    page = 1
    total = 0
    while True:
        response = requests.post(
            f"{api_base.rstrip('/')}/api/memory/list",
            headers=headers(plugin_auth, token, mis),
            json={
                "mis": mis,
                "source": "",
                "agentType": None,
                "type": None,
                "startDate": None,
                "endDate": None,
                "pageNum": page,
                "pageSize": page_size,
            },
            timeout=30,
        )
        response.raise_for_status()
        payload = response.json()
        if payload.get("code") != 200:
            raise RuntimeError(f"CatPaw memory list failed: {payload}")
        data = payload.get("data") or {}
        batch = data.get("items") or []
        total = int(data.get("totalCount") or data.get("total") or total)
        items.extend(batch)
        if not batch or len(items) >= total:
            return items, total, page
        page += 1
        if page > 1000:
            raise RuntimeError("CatPaw memory pagination exceeded 1000 pages")


def normalize(item: dict, index: int) -> dict:
    memory_id = str(item.get("memoryId") or f"unknown-{index}")
    source = str(item.get("source") or "unknown")
    agent_type = str(item.get("agentType") or "unknown")
    content = str(item.get("content") or "").strip()
    title = str(item.get("title") or "").strip()
    timestamp_ms = item.get("eventTime") or item.get("createTime")
    try:
        timestamp = datetime.fromtimestamp(int(timestamp_ms) / 1000, tz=timezone.utc).isoformat().replace("+00:00", "Z") if timestamp_ms else ""
    except (TypeError, ValueError, OSError, OverflowError):
        timestamp = ""
    tags = [str(tag) for tag in (item.get("tags") or []) if str(tag).strip()]
    refs = [f"memoryId:{memory_id}", f"remoteSource:{source}", f"agentType:{agent_type}"]
    refs.extend(f"tag:{tag}" for tag in tags)
    return {
        "message_id": memory_id,
        "conversation_id": str(item.get("conversationId") or f"remote-memory:{source}:{agent_type}"),
        "role": "memory",
        "actor": f"remote:{source}",
        "timestamp": timestamp,
        "content": content or title,
        "refs": refs,
        "participants": [f"remote:{source}", f"agent:{agent_type}"],
        "title": title,
        "remote": item,
    }


def atomic_write(path: Path, text: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    os.chmod(path.parent, 0o700)
    fd, temporary = tempfile.mkstemp(prefix=f".{path.name}.", dir=path.parent)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            handle.write(text)
            handle.flush()
            os.fsync(handle.fileno())
        os.chmod(temporary, 0o600)
        os.replace(temporary, path)
        os.chmod(path, 0o600)
    finally:
        try:
            os.unlink(temporary)
        except FileNotFoundError:
            pass


def main() -> None:
    parser = argparse.ArgumentParser(description="Pull CatPaw remote memories into an IKB JSONL snapshot")
    parser.add_argument("--output", required=True, help="Output JSONL path, normally ikb-data/staging/catpaw-memory/latest.jsonl")
    parser.add_argument("--api-base", default=DEFAULT_API_BASE)
    parser.add_argument("--audience", default=DEFAULT_AUDIENCE)
    parser.add_argument("--mis", default="wuhongteng")
    parser.add_argument("--page-size", type=int, default=100)
    parser.add_argument("--plugin-auth-env", default="IKB_CATPAW_MEMORY_PLUGIN_AUTH")
    args = parser.parse_args()
    if args.page_size < 1 or args.page_size > 100:
        raise SystemExit("--page-size must be between 1 and 100")
    plugin_auth = os.environ.get(args.plugin_auth_env, "").strip()
    if not plugin_auth:
        raise SystemExit(f"Missing CatPaw plugin credential in ${args.plugin_auth_env}; it is not stored in the repository")

    token = access_token(args.audience)
    remote_items, remote_total, pages = pull(args.api_base, token, plugin_auth, args.mis, args.page_size)
    records = [normalize(item, index) for index, item in enumerate(remote_items, 1)]
    text = "".join(json.dumps(record, ensure_ascii=False, separators=(",", ":")) + "\n" for record in records)
    output = Path(args.output).expanduser().resolve()
    manifest = output.with_name(f"{output.stem}.manifest.json")
    source_counts = collections.Counter(str(item.get("source") or "unknown") for item in remote_items)
    type_counts = collections.Counter(str(item.get("type") or "unknown") for item in remote_items)
    retrieved_at = datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")
    manifest_data = {
        "retrievedAt": retrieved_at,
        "endpoint": f"{args.api_base.rstrip('/')}/api/memory/list",
        "mis": args.mis,
        "pageSize": args.page_size,
        "pages": pages,
        "totalCount": len(remote_items),
        "remoteTotalCount": remote_total,
        "contentChars": sum(len(str(item.get("content") or "")) for item in remote_items),
        "sourceCounts": dict(source_counts),
        "typeCounts": dict(type_counts),
        "contentHash": hashlib.sha256(text.encode()).hexdigest(),
    }
    atomic_write(output, text)
    atomic_write(manifest, json.dumps(manifest_data, ensure_ascii=False, indent=2) + "\n")
    print(json.dumps({"snapshot": str(output), "manifest": str(manifest), **manifest_data}, ensure_ascii=False))


if __name__ == "__main__":
    main()
