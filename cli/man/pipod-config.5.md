# pipod-config(5) -- pi pod configuration files

## SYNOPSIS

```
.pi-pod/config.json          a project: the source of its template
~/.pi-pod/config.json        this machine's preferences, and your user layer
~/.pi-pod/org/config.json    the organization layer
```

## DESCRIPTION

Each file is one settings layer's config, written as JSON with comments allowed. The server
merges the layers for each launch (`pipod help layers`), so a file names only what its layer
must decide; anything left out comes from the layers below it. The keys are the same in every
file. `pipod push` uploads a file and `pipod settings <user|org> set <key> <value>` changes
one key on the server.

A key of the wrong type fails the command that reads it, naming the key. An unknown key is
ignored with a warning.

## POD KEYS

These travel to the server and decide what a pod gets. The defaults are the built-in layer's.

```
resources.cpu            vCPUs (default 2)
resources.memoryGB       memory in GB (default 4)
resources.diskGB         workspace disk in GB (default 5)
```

The server may clamp a size to what the host or the organization's policy allows; a launch
reports every clamp.

```
egress.mode              "open" (default) or "allowlist"
egress.allow             hosts a pod may reach under "allowlist"
egress.builtins          also allow the hosts pi pod derives (default true)
```

Under "allowlist" a pod reaches only `egress.allow`, the server itself, and with `builtins`
the model-provider endpoints its Pi sign-ins and settings name. Entries are hostnames, never
addresses. The self-hosted sandbox resolves each to its addresses when a pod starts, so it
refuses wildcards; where a server accepts them, "*.example.com" covers example.com and every
name under it. Git hosts are never derived: list them, and every host the init and bake
scripts download from. Pi packages need registry.npmjs.org.

```
pi.model                 default model, "provider/model-id"
pi.thinking              default thinking level: "off", "minimal", "low", "medium",
                         "high", "xhigh", or "max"
pi.args                  extra arguments for pi in the pod (default [])
pi.command               the command that starts pi (default "pi")
pi.hostConfig.settings   carry the layers' Pi files into pods (default true)
pi.hostConfig.packages   carry settings.json packages into pods and install them
                         (default true)
```

A launch's `--model` and `--thinking` (after `--`) win over `pi.model` and `pi.thinking`.

```
idleTimeoutMinutes       stop a pod after this many idle minutes (default 15); 0 never
                         stops it, so it runs, and costs, until stopped
archiveAfterMinutes      move a stopped pod's workspace to cold storage after this many
                         minutes (default 60)
initTimeoutSeconds       the time limit for the init scripts (default 600)
initOnFailure            when init fails: "abort" the launch (default), "prompt",
                         or "continue"
workdir                  the pod's working directory, an absolute path
                         (default "/workspace")
image                    a custom pod image (default: the managed image matching
                         this pipod)
name                     the project's name in pod names and listings: letters,
                         digits, dots, dashes, underscores (default: the directory's)
labels                   string-to-string labels for the pod
```

## MACHINE KEYS

These stay on this machine: `pipod push` and `pipod settings` never send them.

```
template                 the template launches use: in a project's file, its pinned
                         template; in ~/.pi-pod/config.json, the default elsewhere.
                         --template wins over both, and the project over this machine.
secretResolver           { "type": "1password" }, optionally with "tokenCommand": a
                         command printing a 1Password service-account token (read only
                         from ~/.pi-pod/config.json); resolves op:// secret values
pi.chords                keystrokes for /pod commands while attached:
                         { "enabled": true, "prefix": "ctrl+\\",
                           "bindings": { "d": "detach", "a": "archive", "s": "status",
                                         "l": "list", "w": "switch" } }
pi.sessionNaming         "auto" (default) names a session from its first prompt; "off"
$schema                  ignored
```

## SCRIPTS

A layer's two scripts sit beside its config: .pi-pod/init.sh and .pi-pod/bake.sh in a
project, init.sh and bake.sh in ~/.pi-pod/org/. Every layer's scripts run, lowest layer first.

The init script runs in every pod at launch, as non-interactive bash (`CI=1`,
`DEBIAN_FRONTEND=noninteractive`) in the workdir, with the pod's secrets in its environment.
It is where a project clones its repository and installs dependencies, since a project with a
.pi-pod/config.json gets no copy of its files. A pod reused with `--reuse` runs it again over
the files already there, so write it to make a second run a quick no-op. A failure aborts the
launch unless `initOnFailure` says otherwise.

The bake script is built into the pod image once, and every later launch starts with its
results. On the first launch after an edit, or with a custom `image`, it runs live in the pod
instead, before init. It runs as root in /root, with no secrets, no environment, and no
workspace, so it suits deterministic installs that every pod repeats: `apt-get install`,
`npm install -g`, toolchains. Anything that needs a secret, or differs between pods, belongs in
init.

## EXAMPLES

A project's .pi-pod/config.json that limits network access:

```
{
  "resources": { "cpu": 4, "memoryGB": 8 },
  "egress": {
    "mode": "allowlist",
    "allow": ["github.com", "registry.npmjs.org"]
  },
  "pi": { "model": "anthropic/claude-opus-4-7", "thinking": "high" },
  "template": "my-service"
}
```

Organization defaults, one key at a time:

```
pipod settings org set resources.memoryGB 8
pipod settings org set idleTimeoutMinutes 30
```

## RETIRED KEYS

`envFile`, `initScript`, `bakeScript`, and `reuse` fail with a message saying what replaced
them: the files are always .pi-pod/env, .pi-pod/init.sh, and .pi-pod/bake.sh, and reuse is the
`--reuse` launch flag. `pi.hostConfig.skills` and `pi.hostConfig.extensions` fail the same
way. `provider` and `deniedProviders` warn and are ignored.

## SEE ALSO

pipod(1)
