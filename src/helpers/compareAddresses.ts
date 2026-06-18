/**
 * @notice Compares two addresses, returning true if they are equal
 * @param a The first address
 * @param b The second address
 * @returns boolean
 * @throws If the addresses are not valid
 * @example
 * compareAddresses('0x1234', '0x1234') // true
 */
export default function compareAddresses(a: string, b: string): boolean {
    if (!a.match(/^0x[0-9a-fA-F]{40}$/) || !b.match(/^0x[0-9a-fA-F]{40}$/)) {
        console.error('Invalid address')
        console.table({
            A: {
                Address: a,
            },
            B: {
                Address: b,
            },
        })
        throw new Error('Invalid address')
    }
    return a.toLowerCase() === b.toLowerCase()
}
