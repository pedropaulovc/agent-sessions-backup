---
name: machine-inventory
description: amet is the Windows RTX 3090 box AND the host of this WSL2 dev environment — not a separate Linux machine
metadata:
  type: project
---

`chezmoi execute-template '{{ .chezmoi.hostname }}'` on the WSL2 dev box returns `amet` (verified 2026-07-16): the "main dev box amet" and the Windows host of this WSL2 environment are the same physical machine. Fleet for the collector rollout is therefore `amet-windows` (TPM via CNG Platform Crypto Provider) + `amet-wsl` (no TPM — software key, verified no /dev/tpm*), plus any future machines. The tpm2-openssl Linux flow (spike S3 in [[project-decisions]]) only applies if a native Linux box joins the fleet.
