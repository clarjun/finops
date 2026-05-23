

import { spawn } from "child_process";
import { join } from "path";

export function runPythonScript<T = any>(scriptName: string, inputData: any): Promise<T> {
  return new Promise((resolve, reject) => {
    const scriptPath = join(process.cwd(), "server", "python", scriptName);
    const python = spawn("python", [scriptPath]);

    let output = "";
    let error = "";
    let settled = false;

    const settle = (fn: () => void) => {
      if (!settled) { settled = true; fn(); }
    };

    // Handle spawn failure (e.g. Python not installed)
    python.on("error", (err) => {
      settle(() => reject(`Failed to spawn Python: ${err.message}`));
    });

    // Collect Python stdout
    python.stdout.on("data", (data) => { output += data.toString(); });

    // Collect Python stderr
    python.stderr.on("data", (data) => { error += data.toString(); });

    // Swallow stdin write errors (EOF when Python exits early)
    python.stdin.on("error", () => {});

    // When process closes
    python.on("close", (code) => {
      settle(() => {
        if (code !== 0) {
          reject(error || `Python exited with code ${code}`);
        } else {
          try {
            const jsonStart = output.indexOf("{");
            const jsonEnd = output.lastIndexOf("}");
            const jsonString = output.slice(jsonStart, jsonEnd + 1);
            const parsed = JSON.parse(jsonString);
            resolve(parsed);
          } catch (err) {
            console.error("❌ Failed to parse Python output:", output);
            reject(err);
          }
        }
      });
    });

    // Send JSON input to Python
    try {
      python.stdin.write(JSON.stringify(inputData));
      python.stdin.end();
    } catch {
      // stdin may already be closed if Python failed to start
    }
  });
}
