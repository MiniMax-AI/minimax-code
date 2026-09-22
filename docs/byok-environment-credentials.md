# BYOK environment-variable credentials

Store a reference in the active profile's `config.yaml` to keep an API key out of
that file. The TUI, `mcode exec`, and ACP resolve the reference from their own
process environment when they use the credential.

## Configure an existing provider

Set `WORK_API_KEY` locally in the shell that launches `mcode`. For a POSIX shell,
read the key without displaying it or putting its value in shell history:

```bash
read -s WORK_API_KEY
export WORK_API_KEY
```

In PowerShell:

```powershell
$secureKey = Read-Host 'API Key' -AsSecureString
$env:WORK_API_KEY = [System.Net.NetworkCredential]::new('', $secureKey).Password
```

Edit the existing provider entry in `config.yaml`, keeping its endpoint, API
format, and model definitions:

```yaml
custom_provider:
  work:
    options:
      apiKey: '${WORK_API_KEY}'
```

The official MiniMax API key supports the same syntax:

```yaml
minimax_api:
  apiKey: '${MINIMAX_API_KEY}'
```

Launch `mcode` from the configured shell. Restart a running TUI, exec process, or
ACP host after changing its launch environment; changes in another terminal do
not update an existing process. A launcher or editor that starts ACP must pass
the variable to the child process too.

`provider add --api-key-env NAME` continues to read and save the variable's value.
To retain a reference, edit the saved credential field as shown above.

## Supported syntax and errors

Only a complete `${NAME}` string expands. Names begin with a letter or underscore,
followed by letters, digits, or underscores. `$NAME`, `Bearer ${NAME}`, and
`prefix-${NAME}` remain literal values. A mapping such as `{env: NAME}` is rejected
as the wrong credential type. This feature does not expand Base URLs or custom
request headers.

Missing or whitespace-only variables fail before the model request, with an error
that identifies the provider, credential field, and variable name. Check whether
the variable exists without printing its value. Saved-provider discovery and
connection tests use the same credential resolution; cached connection status
tracks the resolved key, so changing the key invalidates a previous result.

## Configuration and logs

Saving another setting preserves credential reference text and existing YAML
comments. When a configuration value changes, YAML aliases and merge fields are
expanded to independent values: editing one provider cannot change another
provider through a shared anchor, and clearing an inherited key stays cleared
when the file is read again. A no-op write keeps the original text. Changed
files may have normalized whitespace or indentation.

Malformed configuration is rejected without replacing the existing file. POSIX
configuration permissions remain private. Runtime log fields and common
credential text are redacted, while token usage counters remain readable. This
protection does not remove credentials from older logs or files.
