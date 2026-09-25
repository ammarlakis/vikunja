#!/usr/bin/env python3
"""Build the header-auth fork as a static amd64 OCI image without a Docker daemon."""
import argparse
import gzip
import hashlib
import io
import json
import os
from pathlib import Path
import subprocess
import tarfile


def run(*args, **kwargs):
    return subprocess.run(args, check=True, **kwargs)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("output", type=Path, help="New output directory for the OCI image")
    parser.add_argument("--ca-bundle", type=Path, default=Path("/etc/ssl/certs/ca-certificates.crt"))
    args = parser.parse_args()
    root = Path(__file__).resolve().parents[1]
    os.chdir(root)
    if subprocess.check_output(["git", "status", "--porcelain", "--untracked-files=no"], text=True).strip():
        raise SystemExit("Commit tracked source changes before producing a pinned image")
    revision = subprocess.check_output(["git", "rev-parse", "HEAD"], text=True).strip()
    version = "v2.6.0-headerauth-" + revision[:12]
    args.output = args.output.resolve()
    args.output.mkdir(parents=True, exist_ok=False)
    env = dict(os.environ, CI="true", PUPPETEER_SKIP_DOWNLOAD="true", CYPRESS_INSTALL_BINARY="0")
    run("pnpm", "install", "--frozen-lockfile", cwd=root / "frontend", env=env)
    version_file = root / "frontend" / "src" / "version.json"
    original_version = version_file.read_bytes()
    try:
        version_file.write_text(json.dumps({"VERSION": version}))
        run("pnpm", "build", cwd=root / "frontend", env=env)
    finally:
        version_file.write_bytes(original_version)
    binary = args.output / "vikunja"
    run("go", "build", "-trimpath", "-tags", "osusergo netgo", "-ldflags",
        '-s -w -linkmode external -extldflags "-static" -X code.vikunja.io/api/pkg/version.Version=' + version,
        "-o", str(binary), env=dict(os.environ, CGO_ENABLED="1", GOOS="linux", GOARCH="amd64"))
    current_revision = subprocess.check_output(["git", "rev-parse", "HEAD"], text=True).strip()
    dirty = subprocess.check_output(["git", "status", "--porcelain", "--untracked-files=no"], text=True).strip()
    if current_revision != revision or dirty:
        raise SystemExit("Source changed during the build; discard this output and rebuild")
    # The runtime is the same scratch + CA-bundle layout used by the upstream Dockerfile.
    layer = io.BytesIO()
    with tarfile.open(fileobj=layer, mode="w", format=tarfile.PAX_FORMAT) as archive:
        for name, mode in [("tmp", 0o1777), ("app", 0o755), ("app/vikunja", 0o755),
                           ("app/vikunja/files", 0o755), ("db", 0o755),
                           ("etc", 0o755), ("etc/ssl", 0o755), ("etc/ssl/certs", 0o755)]:
            item = tarfile.TarInfo(name)
            item.type = tarfile.DIRTYPE
            item.mode = mode
            item.uid = item.gid = 1000
            archive.addfile(item)
        for source, name, mode in [(binary, "app/vikunja/vikunja", 0o755),
                                   (args.ca_bundle, "etc/ssl/certs/ca-certificates.crt", 0o644)]:
            data = source.read_bytes()
            item = tarfile.TarInfo(name)
            item.size = len(data)
            item.mode = mode
            item.uid = item.gid = 1000
            archive.addfile(item, io.BytesIO(data))
    blobs = args.output / "blobs" / "sha256"
    blobs.mkdir(parents=True)

    def blob(data, media):
        digest = hashlib.sha256(data).hexdigest()
        (blobs / digest).write_bytes(data)
        return {"mediaType": media, "digest": "sha256:" + digest, "size": len(data)}

    def json_blob(value, media):
        return blob(json.dumps(value, sort_keys=True, separators=(",", ":")).encode(), media)

    raw = layer.getvalue()
    compressed = gzip.compress(raw, mtime=0)
    layer_ref = blob(compressed, "application/vnd.oci.image.layer.v1.tar+gzip")
    config = {
        "architecture": "amd64", "os": "linux",
        "config": {
            "User": "1000:1000", "WorkingDir": "/app/vikunja",
            "Entrypoint": ["/app/vikunja/vikunja"], "ExposedPorts": {"3456/tcp": {}},
            "Env": ["VIKUNJA_SERVICE_ROOTPATH=/app/vikunja/", "VIKUNJA_DATABASE_PATH=/db/vikunja.db"],
            "Labels": {"org.opencontainers.image.source": "https://github.com/ammarlakis/vikunja",
                       "org.opencontainers.image.revision": revision,
                       "org.opencontainers.image.version": version,
                       "org.opencontainers.image.licenses": "AGPL-3.0-only"},
        },
        "rootfs": {"type": "layers", "diff_ids": ["sha256:" + hashlib.sha256(raw).hexdigest()]},
        "history": [{"created_by": "scripts/build-header-image.py"}],
    }
    config_ref = json_blob(config, "application/vnd.oci.image.config.v1+json")
    manifest = json_blob({"schemaVersion": 2, "mediaType": "application/vnd.oci.image.manifest.v1+json",
                          "config": config_ref, "layers": [layer_ref]}, "application/vnd.oci.image.manifest.v1+json")
    manifest["annotations"] = {"org.opencontainers.image.ref.name": version}
    (args.output / "index.json").write_text(json.dumps({"schemaVersion": 2, "manifests": [manifest]}))
    (args.output / "oci-layout").write_text('{"imageLayoutVersion":"1.0.0"}')
    (args.output / "build.json").write_text(json.dumps({"revision": revision, "version": version,
        "manifest": manifest["digest"], "binary_sha256": hashlib.sha256(binary.read_bytes()).hexdigest(),
        "go_version": subprocess.check_output(["go", "version"], text=True).strip(),
        "ca_bundle_sha256": hashlib.sha256(args.ca_bundle.read_bytes()).hexdigest()}, indent=2))
    print(json.dumps({"output": str(args.output), "version": version, "digest": manifest["digest"]}))


if __name__ == "__main__":
    main()
