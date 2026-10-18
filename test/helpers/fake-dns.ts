/** Records for a fake DNS resolver: name -> records, or an error code for that name. */
export interface FakeRecords {
    [name: string]: {
        a?: string[],
        aaaa?: string[],
        ns?: string[],
        mx?: { exchange: string, priority: number }[],
        txt?: string[][],
        error?: string
    };
}

function dnsError(code: string): Error {
    return Object.assign(new Error(`query ${code}`), { code });
}

/** Builds an object shaped like dns.promises.Resolver that answers from `records`. */
export function fakeResolver(records: FakeRecords) {
    const answer = <K extends 'a' | 'aaaa' | 'ns' | 'mx' | 'txt'>(name: string, type: K) => {
        const record = records[name];
        if (!record) {
            return Promise.reject(dnsError('ENOTFOUND'));
        }
        if (record.error) {
            return Promise.reject(dnsError(record.error));
        }
        const values = record[type];
        return values?.length ? Promise.resolve(values as NonNullable<FakeRecords[string][K]>) : Promise.reject(dnsError('ENODATA'));
    };
    return {
        resolve4: (name: string) => answer(name, 'a'),
        resolve6: (name: string) => answer(name, 'aaaa'),
        resolveNs: (name: string) => answer(name, 'ns'),
        resolveMx: (name: string) => answer(name, 'mx'),
        resolveTxt: (name: string) => answer(name, 'txt'),
        setServers: () => undefined
    };
}
