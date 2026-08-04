import { test, expect } from './fixtures/environment';
import { SYNTHETIC_FIXTURE as fixture } from './fixtures/synthetic';

test.describe('synthetic sessions viewer', () => {
  test('reports health and renders the first page', async ({ page, appURL }) => {
    const health = await page.goto(appURL('/healthz'));
    expect(health?.ok()).toBeTruthy();
    expect(await health?.json()).toMatchObject({ ok: true });

    const response = await page.goto(appURL('/'));
    expect(response?.ok()).toBeTruthy();
    await expect(page).toHaveTitle(/Search — sessions/);
    await expect(page.getByRole('searchbox')).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Recent sessions' })).toBeVisible();
  });

  test('finds seeded text and navigates to its turn anchor', async ({ page, appURL }) => {
    await page.goto(appURL('/'));
    await page.getByRole('searchbox').fill(fixture.searchPhrase);
    await page.getByRole('button', { name: 'Search' }).click();

    await expect(page).toHaveURL((url) => url.searchParams.get('q') === fixture.searchPhrase);
    await expect(page.locator('.snip').first()).toContainText(fixture.searchPhrase);
    const result = page.locator('.search-results .title a', { hasText: fixture.title }).first();
    await expect(result).toBeVisible();
    await expect(result).toHaveAttribute('href', /\/s\/[^?]+\?page=1#t\d+$/);

    await result.click();
    await expect(page).toHaveURL((url) =>
      url.pathname === `/s/${fixture.sessionId}` &&
      url.searchParams.get('page') === '1' &&
      /^#t\d+$/.test(url.hash),
    );
    const anchor = new URL(page.url()).hash;
    await expect(page.locator(anchor)).toBeVisible();
    await expect(page.locator(anchor)).toContainText(fixture.searchPhrase);
  });

  test('preserves filters and pagination through navigation history', async ({ page, appURL }) => {
    await page.goto(appURL('/?limit=1'));
    await page.getByRole('link', { name: fixture.machineId, exact: true }).click();
    await expect(page).toHaveURL((url) =>
      url.searchParams.get('machine') === fixture.machineId && url.searchParams.get('limit') === '1',
    );
    await expect(page.getByRole('button', { name: 'Clear facets' })).toBeVisible();

    const next = page.getByRole('link', { name: 'Next →' });
    await expect(next).toBeVisible();
    await next.click();
    await expect(page).toHaveURL((url) =>
      url.searchParams.get('machine') === fixture.machineId &&
      url.searchParams.get('limit') === '1' &&
      url.searchParams.has('cursor'),
    );
    await expect(page.getByText('Page 2', { exact: true })).toBeVisible();

    await page.locator('.search-results .title a').first().click();
    await expect(page).toHaveURL(/\/s\//);
    await page.goBack();
    await expect(page).toHaveURL((url) =>
      url.searchParams.get('machine') === fixture.machineId &&
      url.searchParams.get('limit') === '1' &&
      url.searchParams.has('cursor'),
    );
    await expect(page.getByText('Page 2', { exact: true })).toBeVisible();
  });

  test('stars and unstars a turn with same-origin posts that persist after reload', async ({ page, appURL }) => {
    await page.goto(appURL(`/s/${fixture.sessionId}?page=1`));
    const origin = new URL(page.url()).origin;
    const starToggle = page
      .locator('form.turn-star')
      .first()
      .getByRole('button', { name: /^(?:Star|Unstar) turn$/ });

    await expect(starToggle).toBeVisible();
    await expect(starToggle).toHaveAttribute('aria-pressed', /^(?:true|false)$/);
    if (await starToggle.getAttribute('aria-pressed') === 'true') {
      await starToggle.click();
      await expect(starToggle).toHaveAttribute('aria-pressed', 'false');
    }
    await expect(starToggle).toHaveAccessibleName('Star turn');

    const starRequest = page.waitForRequest((request) =>
      request.method() === 'POST' && /\/turns\/\d+\/star(?:\?|$)/.test(request.url()),
    );
    await starToggle.click();
    expect(new URL((await starRequest).url()).origin).toBe(origin);
    await expect(starToggle).toHaveAttribute('aria-pressed', 'true');
    await expect(starToggle).toHaveAccessibleName('Unstar turn');
    await page.reload();
    await expect(starToggle).toHaveAttribute('aria-pressed', 'true');

    const unstarRequest = page.waitForRequest((request) =>
      request.method() === 'POST' && /\/turns\/\d+\/unstar(?:\?|$)/.test(request.url()),
    );
    await starToggle.click();
    expect(new URL((await unstarRequest).url()).origin).toBe(origin);
    await expect(starToggle).toHaveAttribute('aria-pressed', 'false');
    await page.reload();
    await expect(starToggle).toHaveAttribute('aria-pressed', 'false');
  });

  test('loads inline blobs and captured assets as browser subresources', async ({ page, appURL }) => {
    await page.goto(appURL(`/s/${fixture.sessionId}?page=1`));

    for (const route of ['/blob/', '/asset/']) {
      const image = page.locator(`img.media[src*="${route}"]`).first();
      await image.scrollIntoViewIfNeeded();
      await expect(image).toBeVisible();
      await expect.poll(() => image.evaluate((element: HTMLImageElement) => element.complete && element.naturalWidth > 0)).toBe(true);

      const source = await image.getAttribute('src');
      expect(source).toBeTruthy();
      const resourceURL = new URL(source!, page.url());
      expect(resourceURL.origin).toBe(new URL(page.url()).origin);
      const response = await page.evaluate(async (url) => {
        const result = await fetch(url);
        return {
          ok: result.ok,
          contentType: result.headers.get('content-type'),
          byteLength: (await result.arrayBuffer()).byteLength,
        };
      }, resourceURL.toString());
      expect(response.ok).toBeTruthy();
      expect(response.contentType).toMatch(/^image\//);
      expect(response.byteLength).toBeGreaterThan(0);
    }
  });
});
