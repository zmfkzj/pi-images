import { tmpdir } from "node:os";
import { join } from "node:path";

// Runs before each test file's imports, so modules that load image.models.json at
// import time never see the developer's ~/.pi/agent (for example a personal
// image.models.json). The directory is never created: a missing agent directory
// means "no user settings". Live tests keep the real agent directory for credentials.
if (process.env.LIVE_IMAGES !== "1") {
  process.env.PI_CODING_AGENT_DIR = join(tmpdir(), `pi-images-no-agent-dir-${process.pid}-${Date.now()}`);
}
