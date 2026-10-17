# Security Policy

## Supported versions

Only the latest release receives fixes. Please update before reporting.

| Version | Supported |
|---|---|
| 2.2.x | Yes |
| 2.0 to 2.1 | No |
| 1.x | No |

## Security model

Orb is designed for a **closed, trusted local network** at the track, with no internet connection. Knowing the model helps decide whether something is a vulnerability:

- The server listens on the local network (port 8080 by default) so phones, tablets and TVs can view it. It has **no user accounts and no passwords**.
- Only the laptop running the server (`localhost`) and the addresses listed in `engineerHosts` in `data/settings.json` can change the race. Every other client is view-only and the server rejects its changes.
- Device data (Agile over WebSocket and HTTP, Sentinel over HTTP, other sources over UDP port 47800) is accepted from the local network without authentication.
- All data is stored as plain files in the `data` folder.

**Do not expose the server to the internet** (port forwarding, public cloud hosts, tunnels). It is not built for that.

Examples of what we treat as a vulnerability:

- A view-only client managing to change the race state, settings or log
- Reading or writing files outside the `data` folder (path traversal)
- Script injection through names, notes, rule files, imported weekends or device data
- Crashing the server, or corrupting the race log, with a crafted request, WebSocket message or UDP datagram

## Reporting a vulnerability

Please **do not open a public issue** for a security problem.

Report it privately through GitHub: go to the repository's **Security** tab and choose **Report a vulnerability** ([direct link](https://github.com/redc6t/Orb/security/advisories/new)).

Include:

- The version (shown in the README badge and `package.json`)
- What an attacker on the network can do, and what they need (view-only access, a device address, a crafted file)
- Steps to reproduce, or a proof of concept

## What happens next

This is a small project maintained by one person, so timings are best effort:

- An acknowledgement within 7 days
- An assessment and, if confirmed, a plan for a fix within 30 days
- A fixed release, followed by a public advisory crediting you (unless you prefer not to be named)

Thank you for helping keep pit walls safe.
