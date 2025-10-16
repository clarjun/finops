import { spawn } from "child_process";
import { join } from "path";

export function runPythonScript<T = any>(scriptName: string, inputData: any): Promise<T> {
  return new Promise((resolve, reject) => {
    const scriptPath = join(process.cwd(), "server", "python", scriptName);
    
    // Use uv to run the Python script with the correct environment
    const python = spawn("uv", ["run", "python3", scriptPath], {
      stdio: ["pipe", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";

    python.stdout.on("data", (data) => {
      stdout += data.toString();
    });

    python.stderr.on("data", (data) => {
      stderr += data.toString();
    });

    python.on("close", (code) => {
      if (code !== 0) {
        reject(new Error(`Python script failed: ${stderr}`));
        return;
      }

      try {
        const result = JSON.parse(stdout);
        resolve(result);
      } catch (error) {
        reject(new Error(`Failed to parse Python output: ${stdout}`));
      }
    });

    python.on("error", (error) => {
      reject(new Error(`Failed to spawn Python process: ${error.message}`));
    });

    // Send input data to Python script via stdin
    python.stdin.write(JSON.stringify(inputData));
    python.stdin.end();
  });
}
