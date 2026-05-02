import path from 'node:path';

/** Single folder name at the **project vault root** that mirrors the entire common vault (symlink or junction). */
export const COMMON_MOUNT_DIR_NAME = 'common';

/** Vault-relative path (posix) to that mount. */
export const VAULT_RELATIVE_COMMON_MOUNT = COMMON_MOUNT_DIR_NAME;

/** Absolute path to the common-vault mount inside a project vault root. */
export function absoluteCommonMount(projectVaultRoot: string): string {
  return path.join(projectVaultRoot, COMMON_MOUNT_DIR_NAME);
}

/** True if a vault-relative posix path is the mount directory or a file/folder inside it. */
export function isVaultRelativeUnderCommonMount(relativePosixPath: string): boolean {
  const n = relativePosixPath.replace(/\\/g, '/');
  return n === VAULT_RELATIVE_COMMON_MOUNT || n.startsWith(`${VAULT_RELATIVE_COMMON_MOUNT}/`);
}
