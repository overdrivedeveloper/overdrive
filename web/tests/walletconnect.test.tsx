// The WalletConnect option is shown only with a Reown project id (fail closed), and the provider stays out of the
// main bundle (dynamic import only).
import {describe, expect, test} from 'bun:test';
import {readFileSync} from 'node:fs';
import {join} from 'node:path';
import {renderToString} from 'react-dom/server';
import {WalletConnectOption} from '../src/components/WalletConnectOption';
import {reownProjectId, walletConnectEnabled, walletConnectProvider} from '../src/lib/walletconnect';

const ID = '0123456789abcdef0123456789abcdef';
const option = (env: Record<string, string | undefined>) => renderToString(<WalletConnectOption enabled={walletConnectEnabled(env)} onClick={() => {}} />);

describe('WalletConnect option', () => {
  test('hidden without a project id', () => {
    expect(option({})).toBe('');
    expect(option({VITE_REOWN_PROJECT_ID: ''})).toBe('');
    expect(option({VITE_REOWN_PROJECT_ID: '   '})).toBe('');
    expect(option({VITE_REOWN_PROJECT_ID: 'not-an-id'})).toBe('');
  });
  test('shown with a project id', () => {
    expect(reownProjectId({VITE_REOWN_PROJECT_ID: ` ${ID} `})).toBe(ID);
    expect(option({VITE_REOWN_PROJECT_ID: ID})).toContain('WalletConnect');
  });
  test('no id: the provider is never created', async () => {
    await expect(walletConnectProvider('', 4663)).rejects.toThrow('not configured');
  });
  test('the provider package is only loaded with a dynamic import', () => {
    const src = readFileSync(join(import.meta.dir, '../src/lib/walletconnect.ts'), 'utf8');
    expect(src).toContain("import('@walletconnect/ethereum-provider')");
    expect(src).not.toMatch(/^import .*@walletconnect/m);
  });
});
