// The BN254 precompiles (0x06-0x08) are not used by any ReceivaSG contract.
// The real library needs eval() at load time, which the page's security policy forbids.
const unsupported = () => { throw new Error('BN254 precompile not available in the in-browser sandbox'); };
module.exports = { add: unsupported, mul: unsupported, pairing: unsupported };
