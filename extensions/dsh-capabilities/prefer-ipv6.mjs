// Prefer IPv6 for outbound connections from the DSH host process.
//
// Sets Node's DNS result order to `ipv6first` at plugin load, so hosts with
// AAAA records (for example a dual-stack capability gateway) are contacted
// over IPv6 first. Node's Happy Eyeballs (autoSelectFamily, enabled by
// default) still falls back to IPv4 within the attempt timeout when IPv6 is
// unreachable, so this is a preference, never a hard requirement.
//
// Scope note: DNS result order is process-wide. IPv4-only hosts are
// unaffected. To opt out on one profile, disable the `oh-my-harness-prefer-ipv6`
// patch entry in that profile's cordis.patch.yml.

import dns from 'node:dns'

export const name = 'oh-my-harness-prefer-ipv6'

if (typeof dns.setDefaultResultOrder === 'function') {
  dns.setDefaultResultOrder('ipv6first')
}

export function apply() {}
