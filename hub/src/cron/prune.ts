// Daily prune (runs on the `30 4 * * *` cron — see wrangler.jsonc triggers).
//
// Multipart uploads assemble onto a staging key (mpu-staging/...) and complete copies staging ->
// canonical then deletes staging. Two leaks are possible and both are swept here:
//   - an INCOMPLETE multipart upload (collector died before complete): R2 auto-aborts it after 7
//     days on its own, but the staging OBJECT below is the completed-but-uncopied case;
//   - a COMPLETED staging object orphaned by a Worker crash between complete() and the staging
//     delete. Unlike incomplete uploads, a completed object is a normal listable object, so we can
//     find and delete it here.
//
// We list the mpu-staging/ prefix and delete any object older than 7 days — well past the lifetime
// of any in-flight upload, so a live upload is never touched.

const STAGING_PREFIX = 'mpu-staging/';
const STALE_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

export async function runPrune(env: Env, nowMs: number = Date.now()): Promise<void> {
  const cutoff = nowMs - STALE_MS;
  let deleted = 0;
  let scanned = 0;
  let cursor: string | undefined;
  do {
    const page: R2Objects = await env.RAW.list({ prefix: STAGING_PREFIX, cursor, limit: 1000 });
    scanned += page.objects.length;
    const stale = page.objects.filter((o) => o.uploaded.getTime() < cutoff).map((o) => o.key);
    for (const key of stale) {
      await env.RAW.delete(key);
      deleted++;
    }
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
  console.log(JSON.stringify({ event: 'hub.prune.staging', scanned, deleted }));
}
