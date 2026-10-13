// Local startup must distinguish a failed connection from a response-body failure.
// Preserve the original error (including Undici's nested cause/code/socket details)
// rather than reducing either failure to the generic "fetch failed" message.
export async function fetchEnvironmentText(url, options = {}) {
  const method = options.method ?? 'GET';
  let response;
  try {
    response = await fetch(url, options);
    return { response, text: await response.text() };
  } catch (error) {
    const phase = response
      ? `reading HTTP ${response.status} response body (content-type: ${response.headers.get('content-type') ?? 'unspecified'})`
      : 'before receiving an HTTP response';
    throw new Error(`${method} ${url} failed ${phase}`, { cause: error });
  }
}

export async function waitForReadiness(baseUrl, expected, child, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  const url = `${baseUrl}/healthz`;
  let last = 'not probed';
  let lastError;
  while (Date.now() < deadline) {
    if (child.exitCode !== null || child.signalCode !== null) throw new Error(`Wrangler exited before readiness (${child.exitCode ?? child.signalCode})`);
    try {
      const { response, text } = await fetchEnvironmentText(url, { signal: AbortSignal.timeout(1000) });
      lastError = undefined;
      last = `GET ${url}: HTTP ${response.status}`;
      if (response.ok) {
        const body = JSON.parse(text);
        const mismatch = Object.entries(expected).find(([key, value]) => body[key] !== value);
        if (!mismatch) return body;
        last = `diagnostic mismatch for ${mismatch[0]}: expected ${mismatch[1]}, received ${body[mismatch[0]]}`;
      }
    } catch (error) {
      lastError = error;
      last = String(error);
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 150));
  }
  throw new Error(`Wrangler readiness timed out after ${timeoutMs}ms; last probe: ${last}`, { cause: lastError });
}
