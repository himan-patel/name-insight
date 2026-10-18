import { readdirSync, readFileSync } from 'fs';
import { join } from 'path';

const coreDir = join(__dirname, '..', 'app', 'core');

describe('architecture', () => {
    it.each(readdirSync(coreDir).filter(file => file.endsWith('.ts')))(
        'core/%s does not depend on a transport (express, multer, http layer)',
        file => {
            const source = readFileSync(join(coreDir, file), 'utf8');
            const imports = [...source.matchAll(/from\s+'([^']+)'/g)].map(match => match[1]);
            expect(imports.filter(path => /^(express|multer|cors|helmet|swagger-ui-express)$|\/http\//.test(path))).toEqual([]);
        }
    );
});
