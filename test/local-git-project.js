import { mkdirSync, realpathSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';

/** A disposable primary Git root for tests using the standalone-repository Job contract. */
export function localGitProject(parent, name='repository') {
  const root=join(parent,name);
  mkdirSync(root,{recursive:true});
  execFileSync('git',['init','-q','-b','main',root]);
  execFileSync('git',['-C',root,'-c','user.name=Test','-c','user.email=relay-test@example.invalid','commit','--allow-empty','-qm','seed']);
  return realpathSync(root);
}
