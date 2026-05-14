// Out-of-band password reset. Run via `./server.sh reset-password
// <username> <new-password>` from the same machine that hosts
// the server. No HTTP API access is needed; we just edit the
// JSON store directly. This is the only recovery path for a
// forgotten password since the spec says no admin reset.
import { findUserByUsername, store } from "../store";
import { setPasswordDirect } from "../auth/authService";

async function main(): Promise<void> {
  const [, , username, password] = process.argv;
  if (!username || !password) {
    console.error("Usage: reset-password <username> <new-password>");
    process.exit(2);
  }
  const data = await store.load();
  const user = findUserByUsername(data, username);
  if (!user) {
    console.error(`No user named "${username}" exists.`);
    process.exit(1);
  }
  try {
    await setPasswordDirect(user, password);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
  console.log(`Password reset for ${username}. All existing sessions for this user have been invalidated.`);
}

await main();
