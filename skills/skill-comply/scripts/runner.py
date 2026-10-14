"""Run scenarios via claude -p and parse tool calls from stream-json output."""

from __future__ import annotations

import json
import os
import re
import shlex
import shutil
import stat
import subprocess
import tempfile
from dataclasses import dataclass
from pathlib import Path

from scripts.parser import ObservationEvent
from scripts.scenario_generator import Scenario

# Per-user base: another local user cannot pre-create or replace it in the
# sticky temp dir, and _setup_sandbox() keeps it at mode 0700.
SANDBOX_BASE = Path(tempfile.gettempdir()) / (
    f"skill-comply-sandbox-{os.getuid()}" if hasattr(os, "getuid") else "skill-comply-sandbox"
)
ALLOWED_MODELS = frozenset({"haiku", "sonnet", "opus"})
ALLOWED_SETUP_EXECUTABLES = frozenset({
    "git", "npm", "pip", "pip3",
    "touch", "mkdir", "cp", "mv", "echo",
    "chmod", "unzip", "tar",
})
# Setup commands are model output generated from the skill under test, so each
# allowed tool is limited to its file-creating uses. These lists are allowlists
# on purpose: git, tar, npm and pip all have options that run other programs.
SAFE_GIT_SUBCOMMANDS = frozenset({
    "init", "add", "commit", "checkout", "switch", "branch", "tag", "rm", "mv", "config",
})
SAFE_GIT_CONFIG_KEYS = frozenset({"user.name", "user.email", "init.defaultbranch", "commit.gpgsign"})
SAFE_TAR_SHORT_FLAGS = frozenset("cxtvfzjJC")
SAFE_TAR_LONG_OPTIONS = frozenset({
    "--create", "--extract", "--list", "--file", "--directory", "--verbose",
    "--gzip", "--gunzip", "--bzip2", "--xz", "--no-same-owner", "--no-same-permissions",
})
NPM_INSTALL_SUBCOMMANDS = frozenset({"install", "i", "add", "ci"})
NPM_INSTALL_OPTIONS = frozenset({"-D", "--save-dev", "-E", "--save-exact", "--no-save"})
PIP_INSTALL_OPTIONS = frozenset({"-q", "--quiet", "-U", "--upgrade"})
# Registry package names with an optional version; no URLs, paths or git specs.
PACKAGE_SPEC = re.compile(
    r"(@[a-z0-9][\w.-]*/)?[A-Za-z0-9][\w.-]*(\[[\w.,-]+\])?([@=<>!~^][\w.*^~<>=!,-]*)?",
    re.ASCII,
)
# Shell builtins cannot be invoked via subprocess.run; cwd is already
# controlled by the cwd= keyword. Scenarios that include these in
# setup_commands (a common shell-style convention) must be tolerated.
SHELL_BUILTINS = frozenset({"cd", "pushd", "popd"})
REPORT_VALUE_LIMIT = 5000


@dataclass(frozen=True)
class ScenarioRun:
    scenario: Scenario
    observations: tuple[ObservationEvent, ...]
    sandbox_dir: Path


def run_scenario(
    scenario: Scenario,
    model: str = "sonnet",
    max_turns: int = 30,
    timeout: int = 300,
) -> ScenarioRun:
    """Execute a scenario and extract tool calls from stream-json output."""
    if model not in ALLOWED_MODELS:
        raise ValueError(f"Unknown model: {model!r}. Allowed: {ALLOWED_MODELS}")

    sandbox_dir = _safe_sandbox_dir(scenario.id)
    _setup_sandbox(sandbox_dir, scenario)

    result = subprocess.run(
        [
            "claude", "-p", scenario.prompt,
            "--model", model,
            "--max-turns", str(max_turns),
            "--add-dir", str(sandbox_dir),
            "--allowedTools", "Read,Write,Edit,Bash,Glob,Grep",
            "--output-format", "stream-json",
            "--verbose",
        ],
        capture_output=True,
        text=True,
        timeout=timeout,
        cwd=sandbox_dir,
    )

    # claude -p returns rc=1 when --max-turns is reached, but the stream-json
    # output is still complete and parseable. Treat this graceful termination
    # as non-fatal so scenarios that hit the turn cap still produce usable
    # observations.
    nonfatal_max_turns = (
        result.returncode == 1
        and '"terminal_reason":"max_turns"' in result.stdout
    )
    if result.returncode != 0 and not nonfatal_max_turns:
        # Include both stderr and stdout tails. claude -p often surfaces the
        # actual failure context (model error JSON, partial stream-json) on
        # stdout, while stderr carries generic transport / auth messages.
        # Showing both dramatically reduces "rc=N: <empty>" debugging dead-ends.
        raise RuntimeError(
            f"claude -p failed (rc={result.returncode}): "
            f"stderr={result.stderr[:500]!r} stdout_tail={result.stdout[-500:]!r}"
        )

    observations = _parse_stream_json(result.stdout)

    return ScenarioRun(
        scenario=scenario,
        observations=tuple(observations),
        sandbox_dir=sandbox_dir,
    )


def _validate_sandbox_base() -> None:
    """Reject links at the base itself; trusted parent aliases remain usable.

    This is a point-in-time preflight, not protection against concurrent
    replacement of filesystem entries during setup.
    """
    try:
        metadata = SANDBOX_BASE.lstat()
    except FileNotFoundError:
        return
    reparse_point = getattr(stat, "FILE_ATTRIBUTE_REPARSE_POINT", 0x400)
    if stat.S_ISLNK(metadata.st_mode) or getattr(metadata, "st_file_attributes", 0) & reparse_point:
        raise ValueError("Sandbox base must not be a symlink or directory reparse point")
    if not stat.S_ISDIR(metadata.st_mode):
        raise ValueError("Sandbox base must be a directory")
    if hasattr(os, "getuid") and metadata.st_uid != os.getuid():
        raise ValueError("Sandbox base must be owned by the current user")


def _safe_sandbox_dir(scenario_id: str) -> Path:
    """Sanitize scenario ID and ensure path stays within sandbox base."""
    _validate_sandbox_base()
    safe_id = re.sub(r"[^a-zA-Z0-9\-_]", "_", scenario_id)
    path = SANDBOX_BASE / safe_id
    resolved_path = path.resolve()
    resolved_base = SANDBOX_BASE.resolve()
    if not safe_id or resolved_path == resolved_base:
        raise ValueError("Scenario sandbox must be a subdirectory of the sandbox base")
    # Validate path stays within sandbox base (raises ValueError on traversal)
    resolved_path.relative_to(resolved_base)
    return path


def _setup_sandbox(sandbox_dir: Path, scenario: Scenario) -> None:
    """Create sandbox directory and run setup commands."""
    _validate_sandbox_base()
    SANDBOX_BASE.mkdir(mode=0o700, parents=True, exist_ok=True)
    _validate_sandbox_base()
    SANDBOX_BASE.chmod(0o700)
    if sandbox_dir.exists():
        shutil.rmtree(sandbox_dir)
    sandbox_dir.mkdir(parents=True)

    subprocess.run(["git", "init"], cwd=sandbox_dir, capture_output=True)

    for cmd in scenario.setup_commands:
        parts = shlex.split(cmd)
        if not parts or parts[0] in SHELL_BUILTINS:
            # Shell builtins (cd/pushd/popd) cannot run as subprocess; skip.
            continue
        argv = _sandboxed_setup_command(parts, sandbox_dir)
        if argv is None:
            # Not an allowed tool, or a use of it that could run code or
            # reach outside the sandbox.
            continue
        try:
            subprocess.run(argv, cwd=sandbox_dir, capture_output=True)
        except FileNotFoundError:
            # Setup tool not installed in this environment; skip rather than
            # crash the whole scenario. The compliance run continues.
            continue


def _arg_stays_in_sandbox(arg: str, sandbox_dir: Path) -> bool:
    """True if a path-like argument resolves inside the sandbox, outside its .git."""
    if arg.startswith("-"):
        # Option values attached to the flag (--file=/x, -t.., -C/) are not
        # resolved here, so refuse any that could name another directory.
        return not any(token in arg for token in ("/", "\\", "~", ".."))
    if arg.startswith("~"):
        return False
    root = sandbox_dir.resolve()
    try:
        relative = (root / arg).resolve().relative_to(root)
    except ValueError:
        return False
    return ".git" not in {part.lower() for part in relative.parts}


def _packages_allowed(args: list[str], options: frozenset[str]) -> bool:
    return all(
        arg in options or (not arg.startswith("-") and PACKAGE_SPEC.fullmatch(arg))
        for arg in args
    )


def _tar_args_allowed(args: list[str]) -> bool:
    for index, arg in enumerate(args):
        if arg.startswith("--"):
            if arg.split("=", 1)[0] not in SAFE_TAR_LONG_OPTIONS:
                return False
        elif arg.startswith("-") or index == 0:
            # tar also reads a bare first argument as bundled flags ("tar xzf").
            if not set(arg.removeprefix("-")) <= SAFE_TAR_SHORT_FLAGS:
                return False
        elif ":" in arg:
            return False  # host:file archives run a remote shell
    return True


def _sandboxed_setup_command(parts: list[str], sandbox_dir: Path) -> list[str] | None:
    """Return the argv to run for one setup command, or None to skip it.

    Keeps every allowed tool, but only for uses that create files inside the
    sandbox: no option that runs another program, no path outside the sandbox,
    and nothing under the sandbox's .git directory (hooks, config).
    """
    tool, args = parts[0], parts[1:]
    if tool not in ALLOWED_SETUP_EXECUTABLES:
        return None
    if not all(_arg_stays_in_sandbox(arg, sandbox_dir) for arg in args):
        return None
    if tool == "git":
        # The subcommand must come first, which also rules out global
        # options such as -c, -C, --config-env and --exec-path.
        if not args or args[0] not in SAFE_GIT_SUBCOMMANDS:
            return None
        if args[0] == "config" and (len(args) != 3 or args[1].lower() not in SAFE_GIT_CONFIG_KEYS):
            return None
        return parts
    if tool == "tar":
        return parts if _tar_args_allowed(args) else None
    if tool == "npm":
        if args in (["init", "-y"], ["init", "--yes"]):
            return parts
        if args and args[0] in NPM_INSTALL_SUBCOMMANDS and _packages_allowed(args[1:], NPM_INSTALL_OPTIONS):
            return [*parts, "--ignore-scripts"]
        return None
    if tool in {"pip", "pip3"}:
        if args and args[0] == "install" and _packages_allowed(args[1:], PIP_INSTALL_OPTIONS):
            # Wheels only (no setup.py), installed into the sandbox rather than
            # a site dir where a .pth file would run on every Python start.
            return [*parts, "--only-binary=:all:", "--target", str(sandbox_dir / ".pip-packages")]
        return None
    return parts


def _redact_home_path(text: str) -> str:
    """Replace the operator's home directory with a portable placeholder.

    Observations flow into grade() and then into a written report
    (results/<skill>.md) that's meant to be read, diffed, and shared —
    an absolute path bakes the operator's username into every tool call
    that happened to touch anything under $HOME (including the sandbox
    itself, which lives under a tempdir but scenario setup_commands or
    an agent's own tool calls can still reference $HOME directly).
    """
    home = str(Path.home()).rstrip("/\\")
    if not home or home == "/" or re.fullmatch(r"[A-Za-z]:", home):
        return text

    parts = re.split(r"[\\/]+", home)
    home_pattern = r"[\\/]".join(re.escape(part) for part in parts)
    right_boundary = r"(?=$|[\\/]|[\s\"'`,;:)}\]])"
    flags = re.IGNORECASE if re.match(r"^[A-Za-z]:[\\/]", home) else 0
    pattern = re.compile(
        rf"(?<![\w.~+-]){home_pattern}{right_boundary}",
        flags,
    )
    return pattern.sub("~", text)


def _redact_home_paths(value: object) -> object:
    """Return a copy with home paths redacted from string keys and leaves.

    Redacted mapping keys receive a stable numeric suffix when two original
    keys collapse to the same portable value. This preserves every observation
    without leaking the original home path or silently dropping data.
    """
    if isinstance(value, str):
        return _redact_home_path(value)
    if isinstance(value, dict):
        redacted: dict[object, object] = {}
        for key, item in value.items():
            redacted_key = _redact_home_path(key) if isinstance(key, str) else key
            candidate = redacted_key
            suffix = 2
            while candidate in redacted:
                candidate = f"{redacted_key}#{suffix}"
                suffix += 1
            redacted[candidate] = _redact_home_paths(item)
        return redacted
    if isinstance(value, list):
        return [_redact_home_paths(item) for item in value]
    return value


def _serialize_report_value(value: object) -> str:
    """Redact structured report data before encoding and truncating it."""
    redacted = _redact_home_paths(value)
    if isinstance(redacted, (dict, list)):
        serialized = json.dumps(redacted)
    else:
        serialized = str(redacted)
    return serialized[:REPORT_VALUE_LIMIT]


def _parse_stream_json(stdout: str) -> list[ObservationEvent]:
    """Parse claude -p stream-json output into ObservationEvents.

    Stream-json format:
    - type=assistant with content[].type=tool_use → tool call (name, input)
    - type=user with content[].type=tool_result → tool result (output)
    """
    events: list[ObservationEvent] = []
    pending: dict[str, dict] = {}
    event_counter = 0

    for line in stdout.strip().splitlines():
        try:
            msg = json.loads(line)
        except json.JSONDecodeError:
            continue

        msg_type = msg.get("type")

        if msg_type == "assistant":
            content = msg.get("message", {}).get("content", [])
            for block in content:
                if block.get("type") == "tool_use":
                    tool_use_id = block.get("id", "")
                    tool_input = block.get("input", {})
                    pending[tool_use_id] = {
                        "tool": block.get("name", "unknown"),
                        "input": _serialize_report_value(tool_input),
                        "order": event_counter,
                    }
                    event_counter += 1

        elif msg_type == "user":
            content = msg.get("message", {}).get("content", [])
            if isinstance(content, list):
                for block in content:
                    tool_use_id = block.get("tool_use_id", "")
                    if tool_use_id in pending:
                        info = pending.pop(tool_use_id)
                        output_content = block.get("content", "")
                        events.append(ObservationEvent(
                            timestamp=f"T{info['order']:04d}",
                            event="tool_complete",
                            tool=info["tool"],
                            session=msg.get("session_id", "unknown"),
                            input=info["input"],
                            output=_serialize_report_value(output_content),
                        ))

    for _tool_use_id, info in pending.items():
        events.append(ObservationEvent(
            timestamp=f"T{info['order']:04d}",
            event="tool_complete",
            tool=info["tool"],
            session="unknown",
            input=info["input"],
            output="",
        ))

    return sorted(events, key=lambda e: e.timestamp)
