## Collector releases

- Any collector behavior change MUST bump `collector/src/agent_collector/__init__.py` and update `hub/src/collector-version.ts` in the same change. The package version is derived from `__version__`, the heartbeat reports it, and installed collectors use it to distinguish feature builds.
