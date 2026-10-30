/* eslint-disable no-useless-escape */
/**
 * mavis-trash — shell script that moves files to system trash instead of deleting.
 *
 * Seeded into `<dataDir>/bin/mavis-trash` on daemon startup.
 * Used by the permission pipeline to rewrite `rm` commands.
 */

export const TRASH_SCRIPT_CONTENT = `#!/usr/bin/env bash
# mavis-trash — move files to system trash instead of deleting.
# Usage: mavis-trash [-r] [-f] [-rf] [--force] [--no-preserve|--no-preserve-root] [--] file1 file2 ...
# -r/-R are ignored (trash is always recursive). -f/--force skips missing
# targets like rm, but never unlocks protected paths. Everything after -- is
# treated as a target, never as an option.

set -euo pipefail

report_no_files_moved() {
  echo "mavis-trash: no files were moved" >&2
}

argument_error() {
  echo "mavis-trash: $1" >&2
  report_no_files_moved
  exit 64
}

shell_quote() {
  printf '%q' "$1"
}

# Capture the protected directories before processing any targets. pwd -P and
# the directory canonicalization below make aliases such as /tmp/../workspace,
# trailing slashes, and directory symlinks compare against the same path.
START_CWD="$(pwd -P)"
START_HOME=""
if [ -n "\${HOME:-}" ] && [ -d "$HOME" ]; then
  START_HOME="$(cd -P "$HOME" 2>/dev/null && pwd -P)"
fi

# rm-compatible calls receive argv after the caller shell has expanded it.
# Direct mavis-trash keeps its existing recursive, verbose interface.
rm_compatible=false
recursive=true
interactive=false
verbose=true
if [ "\${1:-}" = "--rm-compatible" ]; then
  shift
  rm_compatible=true
  recursive=false
  verbose=false
fi

args=()
no_preserve=false
no_preserve_root=false
force=false
options_ended=false
for arg in "$@"; do
  if $options_ended; then
    args+=("$arg")
    continue
  fi
  if $rm_compatible; then
    case "$arg" in
      --) options_ended=true; continue ;;
      --force) force=true; interactive=false; continue ;;
      --recursive) recursive=true; continue ;;
      --verbose) verbose=true; continue ;;
      --interactive|--interactive=always) interactive=true; force=false; continue ;;
      --interactive=never) interactive=false; continue ;;
      --preserve-root) continue ;;
      --*) argument_error "unsupported rm option: $arg" ;;
      -?*)
        flags="\${arg#-}"
        for ((flag_index = 0; flag_index < \${#flags}; flag_index++)); do
          case "\${flags:$flag_index:1}" in
            f) force=true; interactive=false ;;
            r|R) recursive=true ;;
            i) interactive=true; force=false ;;
            v) verbose=true ;;
            *) argument_error "unsupported rm option: -\${flags:$flag_index:1}" ;;
          esac
        done
        continue
        ;;
    esac
    args+=("$arg")
    continue
  fi
  case "$arg" in
    -f|--force) force=true ;;
    -rf|-fr) force=true ;; # -r part is a no-op: trash is always recursive
    -r|-R|--recursive) ;; # silently ignore
    --no-preserve) no_preserve=true ;;
    --no-preserve-root) no_preserve_root=true ;;
    --) options_ended=true ;;
    *) args+=("$arg") ;;
  esac
done

if $no_preserve && $no_preserve_root; then
  argument_error "--no-preserve and --no-preserve-root cannot be used together"
fi

if [ \${#args[@]} -eq 0 ]; then
  # rm -f with no operands succeeds silently; mirror it so rewritten
  # "rm -f \\"$VAR\\"" call sites keep working when the variable is empty.
  if $force && ! $no_preserve && ! $no_preserve_root; then
    exit 0
  fi
  argument_error "no files specified"
fi

if $no_preserve && [ \${#args[@]} -ne 1 ]; then
  argument_error "--no-preserve accepts exactly one directory"
fi

if $no_preserve_root && [ \${#args[@]} -ne 1 ]; then
  argument_error "--no-preserve-root accepts exactly the root directory"
fi

resolve_absolute_path() {
  local input="$1"
  local parent
  local basename_value
  parent="$(cd "$(dirname -- "$input")" 2>/dev/null && pwd -P)" || true
  if [ -z "$parent" ]; then
    return 1
  fi
  basename_value="$(basename -- "$input")"
  if [ "$basename_value" = "/" ]; then
    printf '/\\n'
    return
  fi
  if [ "$parent" = "/" ]; then
    printf '/%s\\n' "$basename_value"
  else
    printf '%s/%s\\n' "$parent" "$basename_value"
  fi
}

normalize_path() {
  local absolute_path="$1"
  if [ -d "$absolute_path" ]; then
    cd -P "$absolute_path" 2>/dev/null && pwd -P
    return
  fi
  printf '%s\\n' "$absolute_path"
}

path_contains() {
  case "$2" in
    "$1"/*) return 0 ;;
  esac
  return 1
}

protected_reason() {
  local normalized_path="$1"
  local contains_home=false
  local contains_cwd=false
  if [ "$normalized_path" = "/" ]; then
    printf 'root directory'
    return
  fi
  if [ -n "$START_HOME" ] && [ "$normalized_path" = "$START_HOME" ] && [ "$normalized_path" = "$START_CWD" ]; then
    printf 'home directory and current working directory'
    return
  fi
  if [ -n "$START_HOME" ] && [ "$normalized_path" = "$START_HOME" ]; then
    printf 'home directory'
    return
  fi
  if [ "$normalized_path" = "$START_CWD" ]; then
    printf 'current working directory'
    return
  fi
  # Trashing an ancestor would take the protected directory with it.
  if [ -n "$START_HOME" ] && path_contains "$normalized_path" "$START_HOME"; then
    contains_home=true
  fi
  if path_contains "$normalized_path" "$START_CWD"; then
    contains_cwd=true
  fi
  if $contains_home && $contains_cwd; then
    printf 'parent of the home directory and current working directory'
  elif $contains_home; then
    printf 'parent of the home directory'
  elif $contains_cwd; then
    printf 'parent of the current working directory'
  fi
}

report_protected_paths() {
  local count="\${#protected_paths[@]}"
  local i
  if [ "$count" -eq 1 ]; then
    if [ "\${protected_modes[0]}" = "root" ]; then
      echo "mavis-trash: refusing to trash root directory '/'" >&2
      report_no_files_moved
      echo >&2
      echo "To proceed intentionally, run:" >&2
      echo "  mavis-trash --no-preserve-root -- /" >&2
      return
    fi

    echo "mavis-trash: refusing to trash protected path '\${protected_paths[0]}'" >&2
    echo "mavis-trash: '\${protected_paths[0]}' is the \${protected_reasons[0]}" >&2
    report_no_files_moved
    echo >&2
    if [ "\${protected_modes[0]}" = "ancestor" ]; then
      echo "Trashing this directory would also remove the protected directory inside it." >&2
      echo "cd out of it first, then retry:" >&2
      printf '  cd / && mavis-trash -- ' >&2
      shell_quote "\${protected_paths[0]}" >&2
      echo >&2
      return
    fi
    echo "Trash this protected directory separately with:" >&2
    printf '  mavis-trash --no-preserve -- ' >&2
    shell_quote "\${protected_paths[0]}" >&2
    echo >&2
    return
  fi

  echo "mavis-trash: refusing to trash protected paths:" >&2
  for ((i = 0; i < count; i++)); do
    printf '  %s  (%s)\\n' "\${protected_paths[$i]}" "\${protected_reasons[$i]}" >&2
  done
  report_no_files_moved
  echo >&2
  echo "Trash each protected directory separately:" >&2
  for ((i = 0; i < count; i++)); do
    if [ "\${protected_modes[$i]}" = "root" ]; then
      echo "  mavis-trash --no-preserve-root -- /" >&2
    elif [ "\${protected_modes[$i]}" = "ancestor" ]; then
      printf '  cd / && mavis-trash -- ' >&2
      shell_quote "\${protected_paths[$i]}" >&2
      echo >&2
    else
      printf '  mavis-trash --no-preserve -- ' >&2
      shell_quote "\${protected_paths[$i]}" >&2
      echo >&2
    fi
  done
}

# Phase 1: resolve and validate every target. Nothing reaches the platform
# trash backend until the whole batch has passed this loop and policy checks.
original_paths=()
execution_paths=()
normalized_paths=()
is_directories=()
protected_paths=()
protected_reasons=()
protected_modes=()
preflight_failed=0

for target in "\${args[@]}"; do
  if [ -z "$target" ]; then
    if $force; then continue; fi
    echo "mavis-trash: '': No such file or directory" >&2
    preflight_failed=1
    continue
  fi
  absolute_path="$(resolve_absolute_path "$target")" || true
  if [ -z "$absolute_path" ]; then
    if $force; then
      continue
    fi
    echo "mavis-trash: '$target': cannot resolve parent directory (does the path exist? is a shell variable like ~ or \\$HOME unexpanded?)" >&2
    preflight_failed=1
    continue
  fi

  if [ ! -e "$absolute_path" ] && [ ! -L "$absolute_path" ]; then
    if $force; then
      continue
    fi
    echo "mavis-trash: '$absolute_path': No such file or directory" >&2
    preflight_failed=1
    continue
  fi

  normalized_path="$(normalize_path "$absolute_path")" || true
  if [ -z "$normalized_path" ]; then
    echo "mavis-trash: '$absolute_path': cannot resolve path" >&2
    preflight_failed=1
    continue
  fi

  is_directory=false
  if [ -d "$absolute_path" ]; then
    is_directory=true
  fi

  if $rm_compatible && ! $recursive && $is_directory && [ ! -L "$absolute_path" ]; then
    echo "mavis-trash: '$target': is a directory (rm requires -r)" >&2
    preflight_failed=1
    continue
  fi

  original_paths+=("$target")
  execution_paths+=("$absolute_path")
  normalized_paths+=("$normalized_path")
  is_directories+=("$is_directory")

  reason="$(protected_reason "$normalized_path")"
  if [ -n "$reason" ]; then
    protected_paths+=("$normalized_path")
    protected_reasons+=("$reason")
    if [ "$normalized_path" = "/" ]; then
      protected_modes+=("root")
    elif [ "\${reason#parent of}" != "$reason" ]; then
      protected_modes+=("ancestor")
    else
      protected_modes+=("protected")
    fi
  fi
done

if $no_preserve; then
  if [ \${#normalized_paths[@]} -ne 1 ] || [ "\${is_directories[0]:-false}" != "true" ]; then
    argument_error "--no-preserve accepts exactly one directory"
  fi
  if [ "\${normalized_paths[0]}" = "/" ]; then
    echo "mavis-trash: --no-preserve does not permit root directory '/'" >&2
    report_no_files_moved
    echo >&2
    echo "To proceed intentionally, run:" >&2
    echo "  mavis-trash --no-preserve-root -- /" >&2
    exit 64
  fi
  if [ "\${normalized_paths[0]}" != "$START_CWD" ] && { [ -z "$START_HOME" ] || [ "\${normalized_paths[0]}" != "$START_HOME" ]; }; then
    argument_error "--no-preserve only permits the home directory or current working directory"
  fi
  # A home/cwd match must not smuggle out the other protected directory
  # nested inside it (e.g. cwd under home, or home under cwd).
  if [ "\${normalized_paths[0]}" != "$START_CWD" ] && path_contains "\${normalized_paths[0]}" "$START_CWD"; then
    argument_error "'\${normalized_paths[0]}' still contains the current working directory '$START_CWD'; cd out of it first"
  fi
  if [ -n "$START_HOME" ] && [ "\${normalized_paths[0]}" != "$START_HOME" ] && path_contains "\${normalized_paths[0]}" "$START_HOME"; then
    argument_error "'\${normalized_paths[0]}' still contains the home directory '$START_HOME'"
  fi
  execution_paths[0]="\${normalized_paths[0]}"
elif $no_preserve_root; then
  if [ \${#normalized_paths[@]} -ne 1 ] || [ "\${is_directories[0]:-false}" != "true" ] || [ "\${normalized_paths[0]}" != "/" ]; then
    argument_error "--no-preserve-root accepts exactly the root directory"
  fi
  execution_paths[0]="/"
elif [ \${#protected_paths[@]} -gt 0 ]; then
  report_protected_paths
  exit 64
fi

if [ "$preflight_failed" -ne 0 ]; then
  report_no_files_moved
  exit 1
fi

trash_file() {
  local file="$1"

  # The path was already validated during phase 1. Re-check only to turn a
  # race between preflight and execution into an ordinary runtime failure.
  # With -f, duplicates and children of an already moved directory are absent
  # by design. Only absence is ignored; backend move errors still fail.
  if [ ! -e "$file" ] && [ ! -L "$file" ]; then
    if $force; then return 0; fi
    echo "mavis-trash: '$file': No such file or directory" >&2
    return 1
  fi

  case "$(uname -s)" in
    Darwin)
      # The sandbox must move the item in its own restricted process. Neither
      # native recycling API may be used to delegate an unlink outside it.
      local mode="trash"
      if [ -n "\${MAVIS_TRASH_FORCE_MV:-}" ]; then mode="move"; fi
      if osascript -l JavaScript -e '
function moveWithoutOverwrite(source, trashDir) {
  ObjC.import("Foundation");
  ObjC.bindFunction("renamex_np", ["int", ["char *", "char *", "unsigned int"]]);
  ObjC.bindFunction("__error", ["int *", []]);
  var name = source.slice(source.lastIndexOf("/") + 1);
  for (var attempt = 0; attempt < 16; attempt++) {
    var suffix = attempt === 0 ? "" : "." + ObjC.unwrap($.NSUUID.UUID.UUIDString);
    // RENAME_EXCL atomically refuses existing files, directories and symlinks.
    if ($.renamex_np(source, trashDir + "/" + name + suffix, 4) === 0) return;
    var error = $.__error()[0];
    if (error !== 17) throw new Error("exclusive trash move failed: errno " + error);
  }
  throw new Error("exclusive trash move failed: too many name conflicts");
}
function trashWithFileManager(source) {
  ObjC.import("Foundation");
  var error = Ref();
  if (!$.NSFileManager.defaultManager.trashItemAtURLResultingItemURLError(
    $.NSURL.fileURLWithPath(source), null, error
  )) throw new Error("FileManager trash failed: " + ObjC.unwrap(error[0].localizedDescription));
}
function trashWithCoreServices(source) {
  // Only framework/symbol unavailability permits the modern API fallback.
  // Keep Foundation initialization out of the successful CoreServices path:
  // preserve the Put Back behavior validated on macOS 14.
  try {
    ObjC.import("CoreServices");
    ObjC.bindFunction("FSPathMakeRefWithOptions", ["int", ["char *", "unsigned int", "void *", "void *"]]);
    ObjC.bindFunction("FSMoveObjectToTrashSync", ["int", ["void *", "void *", "unsigned int"]]);
  } catch (unavailable) {
    return false;
  }
  ObjC.bindFunction("calloc", ["void *", ["unsigned long", "unsigned long"]]);
  ObjC.bindFunction("free", ["void", ["void *"]]);
  // FSRef is an opaque 80-byte struct. Option 1 preserves a leaf symlink.
  var ref = $.calloc(1, 80);
  try {
    var status = $.FSPathMakeRefWithOptions(source, 1, ref, null);
    if (status === 0) status = $.FSMoveObjectToTrashSync(ref, null, 0);
    // unimpErr / errFSOperationNotSupported; permission and other failures
    // must not be retried through another backend.
    if (status === -4 || status === -1426) return false;
    if (status !== 0) throw new Error("CoreServices trash failed: OSStatus " + status);
    return true;
  } finally {
    $.free(ref);
  }
}
function run(argv) {
  if (argv[1] === "move") {
    moveWithoutOverwrite(argv[0], argv[2]);
  } else if (!trashWithCoreServices(argv[0])) {
    trashWithFileManager(argv[0]);
  }
}' -- "$file" "$mode" "$HOME/.Trash" >/dev/null; then
        return 0
      fi
      if [ "$mode" = "move" ]; then
        echo "mavis-trash: failed to move '$file' to the trash within the sandbox; no unsafe fallback was attempted" >&2
      else
        echo "mavis-trash: failed to trash '$file'" >&2
      fi
      return 1
      ;;
    Linux)
      # Linux: try gio trash first. Skipped inside the sandbox for the same
      # reason as Finder on macOS — it hands the unlink to a desktop service
      # running outside the cage.
      if [ -z "\${MAVIS_TRASH_FORCE_MV:-}" ] && command -v gio >/dev/null 2>&1; then
        if gio trash "$file" 2>/dev/null; then
          return 0
        fi
      fi
      # In-sandbox path (and fallback): XDG Trash spec
      local trash_dir="\${XDG_DATA_HOME:-$HOME/.local/share}/Trash"
      mkdir -p "$trash_dir/files" "$trash_dir/info"
      local basename
      basename="$(basename "$file")"
      local dest="$trash_dir/files/$basename"
      if [ -e "$dest" ]; then
        local ts
        ts="$(date +%s)"
        dest="$trash_dir/files/\${basename}.\${ts}"
        basename="\${basename}.\${ts}"
      fi
      # Write .trashinfo metadata
      cat > "$trash_dir/info/$basename.trashinfo" <<TRASHINFO
[Trash Info]
Path=$file
DeletionDate=$(date +%Y-%m-%dT%H:%M:%S)
TRASHINFO
      mv "$file" "$dest" 2>/dev/null && return 0
      if [ -n "\${MAVIS_TRASH_FORCE_MV:-}" ]; then
        echo "mavis-trash: '$file': the sandbox denied moving this file to the trash (deleting this path is not allowed in the current sandbox mode)" >&2
      else
        echo "mavis-trash: failed to trash '$file'" >&2
      fi
      return 1
      ;;
    *)
      echo "mavis-trash: unsupported OS: $(uname -s)" >&2
      return 1
      ;;
  esac
}

# Phase 2: only a fully validated batch reaches the platform backend. Runtime
# I/O failures retain the existing per-target behavior and return status 1.
exit_code=0
for ((i = 0; i < \${#execution_paths[@]}; i++)); do
  if $interactive; then
    printf "rm: move '%s' to trash? " "\${original_paths[$i]}" >&2
    reply=""
    read -r reply || true
    case "$reply" in [yY]|[yY][eE][sS]) ;; *) continue ;; esac
  fi
  if trash_file "\${execution_paths[$i]}"; then
    if $verbose; then echo "mavis-trash: moved to trash: '\${original_paths[$i]}'"; fi
  else
    exit_code=1
  fi
done

exit $exit_code
`;
