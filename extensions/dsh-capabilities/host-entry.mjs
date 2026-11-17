/** No-op Host entry. Its only job is to give the client module loader a
 * relative plugin row anchored at the root package manifest, so the root
 * `dsh.client` declaration and `./client` export are discovered. */
export function apply() {}
