import { readFile } from 'node:fs/promises';
import { Ajv, type AnySchema } from 'ajv';

export type ArtifactValidationResult = {
  valid: boolean;
  errors: { path: string; message: string }[];
};

/** Explicit, read-only validation. Projects own schemas and decide when to call it. */
export async function validateArtifact(artifactPath: string, schemaPath: string): Promise<ArtifactValidationResult> {
  if (!artifactPath || !schemaPath) throw new Error('artifact validate requires --artifact and --schema');
  const [artifactText, schemaText] = await Promise.all([
    readFile(artifactPath, 'utf8'),
    readFile(schemaPath, 'utf8'),
  ]);
  const artifact: unknown = JSON.parse(artifactText);
  const schema: unknown = JSON.parse(schemaText);
  if (!schema || typeof schema !== 'object' || Array.isArray(schema)) throw new Error('Schema must be a JSON object');
  if ('$async' in schema) throw new Error('Async schemas are not supported');
  const validate = new Ajv({ allErrors: true, strict: false }).compile(schema as AnySchema);
  const valid = validate(artifact);
  if (typeof valid !== 'boolean') throw new Error('Async validation is not supported');
  return {
    valid,
    errors: (validate.errors ?? []).map(error => ({
      path: error.instancePath || '/',
      message: error.message ?? 'invalid value',
    })),
  };
}

export async function runArtifactCommand(action: string, args: string[]): Promise<void> {
  if (action !== 'validate') throw new Error('artifact supports only validate');
  const value = (flag: string): string => {
    const index = args.indexOf(flag);
    return index < 0 ? '' : args[index + 1] ?? '';
  };
  const result = await validateArtifact(value('--artifact'), value('--schema'));
  console.log(JSON.stringify(result, null, 2));
  if (!result.valid) throw new Error('Artifact validation failed');
}
