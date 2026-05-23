// import OpenAI from "openai";


// export const openai = new OpenAI({
//   baseURL: process.env.AI_INTEGRATIONS_OPENAI_BASE_URL,
//   apiKey: process.env.AI_INTEGRATIONS_OPENAI_API_KEY
// });



import OpenAI from "openai";
import dotenv from "dotenv";

dotenv.config();

if (!process.env.OPENAI_API_KEY) {
  throw new Error("Missing OPENAI_API_KEY in environment variables");
}

export const openai = new OpenAI({
  baseURL: process.env.OPENAI_BASE_URL,
  apiKey: process.env.OPENAI_API_KEY,
});
