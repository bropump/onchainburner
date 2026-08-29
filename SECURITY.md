# Security policy

## Supported release

Security fixes are applied to the current `main` branch and the production
deployment at [cooked.diy](https://cooked.diy). Historical commits and local
fork fixtures are not supported releases.

## Reporting a vulnerability

Please report vulnerabilities privately through the repository's
[GitHub Security Advisories](https://github.com/bropump/onchainburner/security/advisories/new).
Do not open a public issue for a vulnerability that could put vault funds,
deployment keys, paid RPC quota, or the funded metadata uploader at risk.

Include the affected commit or deployed address, a minimal reproduction, the
expected impact, and whether the issue has been exercised on mainnet. Do not
move third-party funds or spend service balances while demonstrating a report.

## Mainnet trust boundary

The current program derives a vault from its full immutable configuration and
contains no withdrawal or configuration-update instruction. The deployed
program is still upgradeable by
`4YBssBchMLgRwD7rwP6jG1ubCX1V1zWwyF3tZGyPSpzJ`; until that authority is
revoked, it can replace the program and is an explicit trust boundary.

Mainnet program: `burnLkcSaW4gHz3xXT1vnKZg3oJuH6Wc2yHcmHptyh5`

## Dependency advisories

Some Solana and Irys dependency trees currently include transitive advisories
without a compatible upstream patch. Releases must keep those dependencies
locked, review reachability, and apply compatible upstream updates when they
become available. Dependabot is configured to surface new releases and
advisories rather than silently widening dependency ranges.
