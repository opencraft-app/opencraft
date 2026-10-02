--------------------- MODULE BatchCommitLifecycleSafety ---------------------
EXTENDS BatchCommitLifecycle

TypeOK ==
    /\ currentEpoch \in 1..MaxEpoch
    /\ phase \in [Ops -> Phases]
    /\ opEpoch \in [Ops -> 0..MaxEpoch]
    /\ result \in [Ops -> Results]
    /\ applied \in [Ops -> BOOLEAN]
    /\ version \in [Ops -> Nat]
    /\ nextVersion \in Nat
    /\ batch \subseteq Ops
    /\ batchEpoch \in 0..MaxEpoch
    /\ cohort \in [Ops -> SUBSET Ops]
    /\ head \in [Blocks -> Values]
    /\ acknowledged \in [Ops -> BOOLEAN]
    /\ flushAcked \in BOOLEAN
    /\ flushCut \subseteq Ops
    /\ snapshotTaken \in BOOLEAN
    /\ snapshotHead \in [Blocks -> Values]
    /\ staleApplied \in BOOLEAN

AcknowledgementsAreDurable ==
    \A op \in Ops : acknowledged[op] => result[op] # "None"

BatchResultsAreAtomic ==
    \A op \in Ops :
        result[op] # "None" =>
            \A peer \in cohort[op] : result[peer] # "None"

StaleEpochsAreFenced == ~staleApplied

HeadsMatchCommittedVersions ==
    \A block \in Blocks : head[block] = ExpectedHead(block)

FlushCoversSubmittedCut ==
    flushAcked => \A op \in flushCut : result[op] # "None"

SnapshotImageIsImmutable ==
    snapshotTaken => snapshotHead \in [Blocks -> Values]

Safety ==
    /\ TypeOK
    /\ AcknowledgementsAreDurable
    /\ BatchResultsAreAtomic
    /\ StaleEpochsAreFenced
    /\ HeadsMatchCommittedVersions
    /\ FlushCoversSubmittedCut
    /\ SnapshotImageIsImmutable

=============================================================================
