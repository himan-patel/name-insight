/** Records for a fake DNS resolver: name -> addresses, or an error code for that name. */
export interface FakeRecords {
    [name: string]: { a?: string[], aaaa?: string[], error?: string };
}

function dnsError(code: string): Error {
    return Object.assign(new Error(`query ${code}`), { code });
}

/** Builds an object shaped like dns.promises.Resolver that answers from `records`. */
export function fakeResolver(records: FakeRecords) {
    const answer = (name: string, family: 'a' | 'aaaa') => {
        const record = records[name];
        if (!record) {
            return Promise.reject(dnsError('ENOTFOUND'));
        }
        if (record.error) {
            return Promise.reject(dnsError(record.error));
        }
        const addresses = record[family];
        return addresses?.length ? Promise.resolve(addresses) : Promise.reject(dnsError('ENODATA'));
    };
    return {
        resolve4: (name: string) => answer(name, 'a'),
        resolve6: (name: string) => answer(name, 'aaaa'),
        setServers: () => undefined
    };
}
