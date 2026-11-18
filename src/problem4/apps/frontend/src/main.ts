import { describeRelease, greetingPath, type BackendVersion } from './release.js';

function element<T extends HTMLElement>(selector: string): T {
  const found = document.querySelector<T>(selector);
  if (!found) throw new Error(`index.html has no ${selector}`);
  return found;
}

const release = element<HTMLParagraphElement>('#release');
const form = element<HTMLFormElement>('#greet');
const greeting = element<HTMLParagraphElement>('#greeting');

async function getJson<T>(path: string): Promise<T | undefined> {
  try {
    const response = await fetch(path);
    return response.ok ? ((await response.json()) as T) : undefined;
  } catch {
    return undefined;
  }
}

release.textContent = describeRelease(
  import.meta.env.VITE_APP_VERSION,
  await getJson<BackendVersion>('/api/version'),
);

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  const name = String(new FormData(form).get('name') ?? '');
  const body = await getJson<{ message: string }>(greetingPath(name));
  greeting.textContent = body?.message ?? 'The backend did not answer.';
});
