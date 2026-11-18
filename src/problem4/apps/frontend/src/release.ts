export interface BackendVersion {
  version: string;
  environment: string;
}

// Full commit SHAs are noise on screen; seven characters identify a build.
export function shortVersion(version: string): string {
  return /^[0-9a-f]{40}$/.test(version) ? version.slice(0, 7) : version;
}

export function describeRelease(frontend: string, backend: BackendVersion | undefined): string {
  const web = `frontend ${shortVersion(frontend)}`;
  if (!backend) return `${web} · backend unreachable`;
  return `${web} · backend ${shortVersion(backend.version)} (${backend.environment})`;
}

export function greetingPath(name: string): string {
  return `/api/greeting?${new URLSearchParams({ name: name.trim() })}`;
}
