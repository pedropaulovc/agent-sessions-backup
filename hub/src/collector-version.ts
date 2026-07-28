/** The collector build the fleet is expected to be running.
 *
 * MUST equal `version` in collector/pyproject.toml — test/collector-version.test.ts fails the build
 * if they drift, so bumping the collector is what moves this, not a separate decision. The watchdog
 * emits it next to each machine's reported version so the collector-outdated alert can compare the
 * two in Log Analytics rather than hard-coding a version in KQL (which nothing would keep in sync).
 *
 * A machine reporting anything else — older, newer, or null because it never sent one — is a machine
 * whose uploads are produced by code no one reviewed against this hub.
 */
export const EXPECTED_COLLECTOR_VERSION = '0.1.0';
