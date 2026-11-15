import "dotenv/config";
import { interactiveLogin } from "./auth.js";

interactiveLogin()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e.message);
    process.exit(1);
  });
