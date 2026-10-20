// Ngobe's own credentials are not the business of the programs it runs: a project's scripts,
// its git config or a planted tool could read them (and `echo $X` would hand them to the model).
const SCRUBBED = [
  "NGOBE_API_KEY",
  "MUGAMBA_API_KEY",
  "NGOBE_BRAVE_API_KEY",
  "NGOBE_TAVILY_API_KEY",
  "NGOBE_SEARXNG_KEY",
  "MUGAMBA_SEARXNG_KEY",
  "BRAVE_API_KEY",
  "TAVILY_API_KEY",
  "GITHUB_TOKEN",
  "GH_TOKEN",
];

/** The environment for child processes: this process's, without Ngobe's credentials. */
export function childEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const key of SCRUBBED) delete env[key];
  return env;
}
