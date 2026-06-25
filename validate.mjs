/**
 * Rentalify — validate a pipeline output file against rental-listings.schema.json.
 * Usage:  node validate.mjs [path-to-output.json]
 * Default target: ./example-output.json
 * Requires dev deps:  npm i -D ajv ajv-formats
 */
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const schemaPath = join(__dirname, "rental-listings.schema.json");
const target = process.argv[2] || join(__dirname, "example-output.json");

const schema = JSON.parse(readFileSync(schemaPath, "utf8"));
const data = JSON.parse(readFileSync(target, "utf8"));

const ajv = new Ajv2020({ allErrors: true, strict: false });
addFormats(ajv);

const validate = ajv.compile(schema);
if (validate(data)) {
  console.log(`VALID  ${target}  (${data.listings?.length ?? 0} listings)`);
} else {
  console.log(`INVALID  ${target}`);
  console.log(JSON.stringify(validate.errors, null, 2));
  process.exit(1);
}
