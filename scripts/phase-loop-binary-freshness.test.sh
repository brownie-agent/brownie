#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PHASE_LOOP="$REPO_ROOT/phase-loop.sh"
fixture="$(mktemp -d)"

cleanup() {
  rm -rf "$fixture"
}
trap cleanup EXIT

helpers="$fixture/binary-helpers.sh"
python3 - "$PHASE_LOOP" "$helpers" <<'PY'
import pathlib
import sys

source = pathlib.Path(sys.argv[1]).read_text(encoding="utf-8")
parts = []
for name in [
    "phase_loop_configured_binaries_are_workspace_managed",
    "rebuild_brownie_binaries_for_freshness",
]:
    start = source.index(f"{name}() {{")
    end = source.index("\n}\n\n", start) + 3
    parts.append(source[start:end])
pathlib.Path(sys.argv[2]).write_text("\n".join(parts), encoding="utf-8")
PY

workspace="$fixture/workspace"
target_dir="$fixture/dynamic-cargo-target"
fake_bin="$fixture/bin"
trace="$fixture/cargo.trace"
mkdir -p "$workspace" "$target_dir/debug" "$fake_bin"

printf '%s\n' '#!/usr/bin/env bash' 'exit 0' > "$target_dir/debug/brownie"
printf '%s\n' '#!/usr/bin/env bash' 'exit 0' > "$target_dir/debug/brownie-runtime"
chmod +x "$target_dir/debug/brownie" "$target_dir/debug/brownie-runtime"

cat > "$fake_bin/cargo" <<'SH'
#!/usr/bin/env bash
set -euo pipefail
case "${1:-}" in
  metadata)
    printf '{"target_directory":"%s"}\n' "${PHASE_LOOP_TEST_TARGET_DIR:?}"
    printf '%s\n' "$*" >> "${PHASE_LOOP_TEST_CARGO_TRACE:?}"
    ;;
  clean|build)
    printf '%s\n' "$*" >> "${PHASE_LOOP_TEST_CARGO_TRACE:?}"
    ;;
  *)
    printf 'unexpected cargo invocation: %s\n' "$*" >&2
    exit 64
    ;;
esac
SH
chmod +x "$fake_bin/cargo"

PATH="$fake_bin:$PATH" \
PHASE_LOOP_WORKSPACE_ROOT="$workspace" \
PHASE_LOOP_TEST_TARGET_DIR="$target_dir" \
PHASE_LOOP_TEST_CARGO_TRACE="$trace" \
PHASE_LOOP_SKIP_BINARY_FRESHNESS_CHECK=0 \
PHASE_LOOP_BROWNIE_BIN_EXPLICIT=1 \
BROWNIE_BIN="$target_dir/debug/brownie" \
BROWNIE_RUNTIME_PATH="$target_dir/debug/brownie-runtime" \
bash -c 'source "$1"; rebuild_brownie_binaries_for_freshness' _ "$helpers"

test "$(sed -n '1p' "$trace")" = 'metadata --format-version 1 --no-deps'
test "$(sed -n '2p' "$trace")" = 'clean'
test "$(sed -n '3p' "$trace")" = 'build -p brownie-cli --bin brownie -p brownie-runtime --bin brownie-runtime'
test "$(wc -l < "$trace" | tr -d ' ')" = '3'

: > "$trace"
external_cli="$fixture/external-cli"
external_runtime="$fixture/external-runtime"
printf '%s\n' '#!/usr/bin/env bash' 'exit 0' > "$external_cli"
printf '%s\n' '#!/usr/bin/env bash' 'exit 0' > "$external_runtime"
chmod +x "$external_cli" "$external_runtime"

set +e
external_output="$(
  PATH="$fake_bin:$PATH" \
  PHASE_LOOP_WORKSPACE_ROOT="$workspace" \
  PHASE_LOOP_TEST_TARGET_DIR="$target_dir" \
  PHASE_LOOP_TEST_CARGO_TRACE="$trace" \
  PHASE_LOOP_SKIP_BINARY_FRESHNESS_CHECK=0 \
  PHASE_LOOP_BROWNIE_BIN_EXPLICIT=1 \
  BROWNIE_BIN="$external_cli" \
  BROWNIE_RUNTIME_PATH="$external_runtime" \
  bash -c 'source "$1"; rebuild_brownie_binaries_for_freshness' _ "$helpers" 2>&1
)"
external_status=$?
set -e

test "$external_status" -eq 1
printf '%s' "$external_output" | grep -F 'not the selected workspace-managed Cargo target pair' >/dev/null
test "$(sed -n '1p' "$trace")" = 'metadata --format-version 1 --no-deps'
test "$(wc -l < "$trace" | tr -d ' ')" = '1'

python3 - "$PHASE_LOOP" <<'PY'
import pathlib
import sys

source = pathlib.Path(sys.argv[1]).read_text(encoding="utf-8")
assert 'if rebuild_output="$(rebuild_brownie_binaries_for_freshness 2>&1)"; then' in source
assert 'if rebuild_after_restore_output="$(rebuild_brownie_binaries_for_freshness 2>&1)"; then' in source
PY
