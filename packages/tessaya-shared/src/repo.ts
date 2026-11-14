/** The GitHub repository releases and the updater come from. Change `DEFAULT_REPO` at the repo-rename cutover; GitHub redirects the old name meanwhile. */
export const DEFAULT_REPO = "RabHanz/tessaya";

export const repoSlug = (env: Readonly<Record<string, string | undefined>>): string =>
  env["TESSAYA_REPO"]?.trim() || env["BATON_REPO"]?.trim() || DEFAULT_REPO;

export const releasesUrl = (env: Readonly<Record<string, string | undefined>>): string =>
  `https://github.com/${repoSlug(env)}/releases`;
