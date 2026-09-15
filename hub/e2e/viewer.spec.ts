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

  test('navigates the Skills tab and reads a backed-up managed skill', async ({ page, appURL }) => {
    await page.goto(appURL('/'));
    await page.getByRole('link', { name: 'Skills', exact: true }).click();

    await expect(page).toHaveURL((url) => url.pathname === '/skills');
    await expect(page.getByRole('heading', { name: 'Skills', exact: true })).toBeVisible();
    const skill = page.getByRole('link', { name: fixture.skillName, exact: true });
    await expect(skill).toBeVisible();
    await skill.click();

    await expect(page.getByRole('heading', { name: fixture.skillName, exact: true })).toBeVisible();
    await expect(page.locator('.skill-source')).toContainText(fixture.skillSourceMarker);
    await expect(page.getByText('1 backed-up package file', { exact: true })).toBeVisible();
  });

  test('keeps the Skills tab within the viewport at supported mobile widths', async ({ page, appURL }) => {
    for (const width of [320, 375, 414, 768]) {
      await page.setViewportSize({ width, height: 720 });
      await page.goto(appURL('/skills'));
      await expect(page.getByRole('heading', { name: 'Skills', exact: true })).toBeVisible();
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
    }
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

  test('finds the pager seed through the remote smoke marker', async ({ page, appURL }) => {
    await page.goto(appURL('/'));
    await page.getByRole('searchbox').fill(fixture.pagerSearchPhrase);
    await page.getByRole('button', { name: 'Search' }).click();

    await expect(page).toHaveURL((url) => url.searchParams.get('q') === fixture.pagerSearchPhrase);
    await expect(page.locator('.snip').first()).toContainText(fixture.pagerSearchPhrase);
    const result = page.locator('.search-results .title a', { hasText: fixture.pagerTitle }).first();
    await expect(result).toBeVisible();
    await result.click();
    await expect(page).toHaveURL((url) => url.pathname === `/s/${fixture.pagerSessionId}`);
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

  test('rolls subagent cost into the session list and breaks it down by model', async ({ page, appURL }) => {
    // The list figure covers the whole subtree, so it must exceed what the parent spent on its
    // own turns; the coverage caveat and the subagent count live in the chip's tooltip and on the
    // session page, not in the row.
    // Scoped to the fixture machine so a developer's own imported corpus cannot push the fixture
    // off the first page of a cost-ranked list.
    await page.goto(appURL(`/?sort=cost&machine=${encodeURIComponent(fixture.machineId)}`));
    const row = page.locator('.hit', { hasText: fixture.costParentTitle }).first();
    await expect(row).toBeVisible();
    const subagents = fixture.costSubagentSessionIds.length;
    await expect(row).toContainText(fixture.costSubtreeAmount);
    await expect(row).not.toContainText('incl.');

    await row.getByRole('link', { name: fixture.costParentTitle }).click();
    await expect(page).toHaveURL((url) => url.pathname === `/s/${fixture.costParentSessionId}`);
    await expect(page.locator('.sesshead')).toContainText(
      `cost: ${fixture.costSubtreeLabel} · incl. ${subagents} subagents`,
    );

    // Every child is linked with its own cost, and the unpriced one says so instead of showing $0.
    const banner = page.locator('.banner', { hasText: 'Subagents (' });
    await expect(banner).toContainText(`Subagents (${subagents})`);
    await expect(banner).toContainText('unknown');

    const panel = page.locator('details.session-cost');
    // The panel covers the same subtree as the header, so its summary is the rolled-up figure.
    await expect(panel).toContainText(`${fixture.costSubtreeLabel} incl. ${subagents} subagents`);
    await panel.locator('summary').click();
    const modelRow = panel.locator('tbody tr', { hasText: fixture.costParentModel });
    await expect(modelRow).toContainText(fixture.costParentOwnLabel);
    await expect(modelRow).toContainText('this session only');
    // Claude reports cache reads BESIDE the input count, so the hit rate divides by their sum
    // (400k of 120k + 400k) — the check that the accounting basis reached the denominator.
    await expect(modelRow).toContainText('76.9%');
    // A model only ever run by a subagent is a row here, attributed to the subagent — this panel
    // used to omit it while the header above counted its dollars. The unpriced one still reads
    // as unknown rather than as free.
    const subagentRow = panel.locator('tbody tr', { hasText: fixture.costUnpricedModel });
    await expect(subagentRow).toContainText(`${subagents === 1 ? '1 subagent' : '1 subagent'} only`);
    await expect(subagentRow).not.toContainText('$0.00');
    // The footer keeps the parent's own spend and the rolled-up total on separate rows.
    await expect(panel.locator('tfoot')).toContainText(fixture.costParentOwnLabel);
    await expect(panel.locator('tfoot')).toContainText(fixture.costSubtreeLabel);
  });

  test('narrows the list to a cost band from the sidebar facet', async ({ page, appURL }) => {
    await page.goto(appURL(`/?machine=${encodeURIComponent(fixture.machineId)}`));
    // The fixture's $2.15 subtree puts it in the $1–$10 band; the unpriced sidecars have no band
    // at all, which is why selecting one must not bring them back.
    const band = page.locator('.sidebar li', { hasText: fixture.costBandLabel }).first();
    await expect(band).toBeVisible();
    await band.getByRole('link').click();

    await expect(page).toHaveURL((url) => url.searchParams.get('cost') === fixture.costBandValue);
    const row = page.locator('.hit', { hasText: fixture.costParentTitle }).first();
    await expect(row).toContainText(fixture.costSubtreeAmount);
    // Everything still listed carries a dollar figure: a session with no known cost has no band.
    for (const hit of await page.locator('.hit').all()) await expect(hit).toContainText('$');
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
