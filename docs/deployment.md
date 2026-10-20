# Deployment (Ubuntu VPS with Docker Model Runner)

Target used for sizing: 6 vCPUs, ~11 GiB RAM, CPU-only inference through Docker Model Runner (llama.cpp backend). Nothing here has been run on that VPS yet; `ngobe doctor` and `ngobe benchmark` are how you verify it there.

## 1. Runtime

The standalone binary needs nothing else. Optional but recommended: `ripgrep` (`apt install ripgrep`) for fast grep, and `git`.

## 2. Install

    curl -fsSL https://raw.githubusercontent.com/ngobe-ai/ngobe-cli/main/install.sh | sh
    ngobe --version

The script picks the right build (including the "baseline" x64 build for CPUs or VMs without AVX2), verifies its SHA-256 and installs to `~/.local/bin`. Alternatives: `npm install -g @ngobe-ai/ngobe` (needs Node.js 22.13+), or build your own binary from source with Bun:

    sudo git clone https://github.com/ngobe-ai/ngobe-cli /opt/ngobe-cli && cd /opt/ngobe-cli
    bun install && bun scripts/build-binaries.ts linux-x64
    install -m 755 dist-bin/ngobe-linux-x64/ngobe ~/.local/bin/ngobe

Run it as your normal user, not root: the agent's commands run with your permissions.

## 3. Model endpoint

Docker Model Runner serves an OpenAI-compatible API, by default on `http://localhost:12434/engines/v1` (host TCP access must be enabled; some versions also expose `/engines/llama.cpp/v1`). Confirm what your install exposes:

    docker model ls
    curl -s http://localhost:12434/engines/v1/models

Then:

    export NGOBE_BASE_URL=http://localhost:12434/engines/v1
    export NGOBE_MODEL=<id from docker model ls>
    ngobe doctor

`doctor` shows whether the endpoint answers, how long a tiny request takes, whether the model calls tools natively (otherwise the text protocol is used automatically), and the model's size against available memory where the server reports it.

The Model Runner API has no authentication. Keep port 12434 bound to localhost or blocked by the firewall; never publish it. Docker-published ports bypass `ufw`, so check from another machine (`nc -z <server-ip> 12434` should fail).

To use the server's models from your laptop, let Ngobe tunnel over SSH (configuration.md, "Models on your own server"): put `sshTunnel`, `sshTunnelTarget` and a local `baseURL` in `~/.config/ngobe/config.json` on the laptop, and `ngobe` opens and closes the tunnel by itself.

## 4. Memory budget on 11 GiB

- Ngobe itself: ~45–110 MB depending on the command.
- Model: quantized weights plus KV cache. A 7–8B coding model at Q4 (~4.5–5 GiB of weights) leaves room for the KV cache, the OS and Docker. A 14B model at Q4 (~9 GiB) is borderline on 11 GiB; larger models won't fit.
- Load one model at a time. Use `NGOBE_FALLBACK_MODEL` only for a model that fits alongside; on 11 GiB, a 7B and a 3B loaded together plus other services can run the machine out of memory.
- Give the model only the context Ngobe needs. Docker Model Runner defaults to the model's maximum (32k for Qwen2.5-Coder) with 4 parallel slots, which cost the 7B about 8.9 GiB of RAM here; at 16k it used about 5.3 GiB. `docker model configure --context-size` only lasts until the model unloads (5 idle minutes by default), so make a variant that keeps it:

      docker model package --from <model> --context-size 16384 ngobe/<name>:16k   # no extra disk; shares the weights
      # then use the API id it gets (e.g. docker.io/ngobe/<name>:16k) as NGOBE_MODEL

  16k comfortably holds Ngobe's ~2,700 tokens of tools and instructions plus `NGOBE_MAX_CONTEXT_CHARS=32000` of history.
- Keep Q4_K_M on CPU; Q4_0 is not faster with a current llama.cpp. Measured on a 6-vCPU AMD EPYC (AVX2), llama.cpp build 9879, Qwen2.5-Coder 7B, Ngobe's 1,550-token first request without cache:

  | | Q4_0 | Q4_K_M |
  |---|---|---|
  | Prompt reading | 23.3–23.7 tok/s | 23.1–23.8 tok/s |
  | Generation | 8.7–9.7 tok/s | 10.7–11.7 tok/s |
  | RAM (anonymous) | 4.8 GiB | 4.4 GiB |

  To try another quantization, download the one `.gguf` and use `docker model package --gguf <file> --context-size 16384 …`: pulling `hf.co/<repo>:Q4_0` matches every file whose name contains Q4_0 (Q4_0_4_4, Q4_0_8_8 …) and downloads them all.
- Size the history to the model's context window (`NGOBE_MAX_CONTEXT_CHARS`, see configuration.md). On CPU, prompt processing time grows with context; smaller windows answer sooner.
- Raise `NGOBE_REQUEST_TIMEOUT` if `doctor` shows long first-token times.

## 5. Live sources and search

Version, release-note and advisory lookups reach the official hosts directly (nodejs.org, storage.googleapis.com, pypi.org, registry.npmjs.org, repo.packagist.org, pub.dev, crates.io, api.github.com, api.osv.dev, php.net, go.dev, python.org, postgresql.org). Allow outbound HTTPS to them. For web search, set one provider: `BRAVE_API_KEY`, `TAVILY_API_KEY`, or a self-hosted SearXNG with `NGOBE_SEARXNG_URL`. Set `GITHUB_TOKEN` if many lookups hit GitHub's 60/hour limit.

## 6. Running unattended

- `ngobe ask|plan|review` never modify anything.
- `--mode auto` runs ordinary writes and commands without asking; dangerous ones still need a person, and with no terminal they are denied. Use it in a container or a disposable checkout.
- Exit codes: 0 on success, 1 when a run fails or hits a limit, 2 for usage errors. `ngobe test` returns the test command's exit code.

## 7. Upgrade

    ngobe update        # standalone install; `ngobe doctor` says when one is available
    ngobe doctor

npm installs: `npm install -g @ngobe-ai/ngobe@latest`. Source builds: `cd /opt/ngobe-cli && git pull && bun install && bun scripts/build-binaries.ts linux-x64`, then copy the binary again.

The memory schema is created with `create table if not exists`; upgrades keep existing data.

## 8. Backup and reset

    ngobe memory export ~/ngobe-memory.json     # facts, runs, failures, variants as JSON
    cp ~/.local/state/ngobe/ngobe.db ~/ngobe.db.bak
    ngobe memory clear --yes                     # forget everything learned (variants kept)
    rm -rf ~/.cache/ngobe                        # HTTP cache; always safe

## 9. Measuring on the target

    ngobe doctor                       # latencies, memory headroom, tool-calling mode
    ngobe benchmark                    # score the prompt in use with this model
    /usr/bin/time -v ngobe ask "what is the latest stable Flutter version?"

Benchmark results are stored per prompt variant and model; `ngobe learn variants` lists them.
