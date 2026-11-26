// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.28;

/// @title Settles whether QoreChain's PQC precompile is reachable from contract code.
/// @notice Booth's whole eligibility design rests on the answer. It was first
///         measured with an `eth_call` state override, which left one honest
///         doubt: the override address has no real Cosmos account, and these
///         precompiles are stateful. This contract is DEPLOYED, so that doubt
///         does not apply.
///
/// Not part of Booth's trust path — it is evidence, kept in the repo so the
/// claim in docs/VERIFIED-FACTS.md can be re-checked by anyone.
contract PqcProbe {
    address public constant PQC_VERIFY = 0x0000000000000000000000000000000000000a01;
    address public constant SHA256_PRECOMPILE = 0x0000000000000000000000000000000000000002;

    /// @return ok did the sub-call succeed
    /// @return returnedBytes how many bytes came back (0 means "answered nothing")
    /// @return data the raw return data
    function probeStatic(address target, bytes calldata payload)
        external
        view
        returns (bool ok, uint256 returnedBytes, bytes memory data)
    {
        (bool s, bytes memory d) = target.staticcall(payload);
        return (s, d.length, d);
    }

    /// Same, with a non-static CALL, in case the precompile refuses static context.
    function probeCall(address target, bytes calldata payload)
        external
        returns (bool ok, uint256 returnedBytes, bytes memory data)
    {
        (bool s, bytes memory d) = target.call(payload);
        return (s, d.length, d);
    }
}
