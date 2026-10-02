------------------------- MODULE MetaLifecycle -------------------------
EXTENDS Naturals, FiniteSets

CONSTANTS Layers, Roots, Snapshots, MaxCommits, Mutation

NoRoot == "NoRoot"
NoLayer == "NoLayer"

ASSUME /\ Layers # {}
       /\ Roots # {}
       /\ Snapshots # {}
       /\ NoRoot \notin Roots
       /\ NoLayer \notin Layers
       /\ MaxCommits \in Nat \ {0}
       /\ Mutation \in {
            "None",
            "ForkWithoutPin",
            "DeleteReferencedRoot",
            "MissingGcOutbox",
            "PublishAfterDelete",
            "RetryDoubleRelease"
          }

LayerStates == {"Missing", "Active", "Deleted"}
RootStates == {"Missing", "Published", "Deleting", "Deleted"}
GcStates == {"None", "Pending", "Done"}

MaxRefs == 2 * Cardinality(Layers) + Cardinality(Snapshots) + Cardinality(Roots)

VARIABLES
    commitVersion,
    layerState,
    layerHead,
    layerBase,
    rootState,
    rootParent,
    rootOwner,
    rootCommit,
    rootRefCount,
    snapshotRoot,
    snapshotUsed,
    gcState,
    postDeletePublish

vars == <<
    commitVersion,
    layerState,
    layerHead,
    layerBase,
    rootState,
    rootParent,
    rootOwner,
    rootCommit,
    rootRefCount,
    snapshotRoot,
    snapshotUsed,
    gcState,
    postDeletePublish
>>

VisibleRoot(layer) ==
    IF layerHead[layer] # NoRoot THEN layerHead[layer] ELSE layerBase[layer]

LayerHeadRefs(root) == {layer \in Layers : layerHead[layer] = root}
LayerBaseRefs(root) == {layer \in Layers : layerBase[layer] = root}
SnapshotRefs(root) == {snapshot \in Snapshots : snapshotRoot[snapshot] = root}
ParentRefs(root) ==
    {child \in Roots :
        /\ rootParent[child] = root
        /\ rootState[child] \in {"Published", "Deleting"}}

ExpectedRefCount(root) ==
    Cardinality(LayerHeadRefs(root)) +
    Cardinality(LayerBaseRefs(root)) +
    Cardinality(SnapshotRefs(root)) +
    Cardinality(ParentRefs(root))

Init ==
    /\ commitVersion = 0
    /\ layerState = [layer \in Layers |-> "Missing"]
    /\ layerHead = [layer \in Layers |-> NoRoot]
    /\ layerBase = [layer \in Layers |-> NoRoot]
    /\ rootState = [root \in Roots |-> "Missing"]
    /\ rootParent = [root \in Roots |-> NoRoot]
    /\ rootOwner = [root \in Roots |-> NoLayer]
    /\ rootCommit = [root \in Roots |-> 0]
    /\ rootRefCount = [root \in Roots |-> 0]
    /\ snapshotRoot = [snapshot \in Snapshots |-> NoRoot]
    /\ snapshotUsed = {}
    /\ gcState = [root \in Roots |-> "None"]
    /\ postDeletePublish = FALSE

CreateLayer(layer) ==
    /\ commitVersion < MaxCommits
    /\ layerState[layer] = "Missing"
    /\ layerState' = [layerState EXCEPT ![layer] = "Active"]
    /\ commitVersion' = commitVersion + 1
    /\ UNCHANGED <<
           layerHead, layerBase, rootState, rootParent, rootOwner,
           rootCommit, rootRefCount, snapshotRoot, snapshotUsed,
           gcState, postDeletePublish
       >>

PublishRoot(layer, root) ==
    LET parent == VisibleRoot(layer) IN
    /\ commitVersion < MaxCommits
    /\ rootState[root] = "Missing"
    /\ \/ layerState[layer] = "Active"
       \/ /\ Mutation = "PublishAfterDelete"
          /\ layerState[layer] = "Deleted"
    /\ IF parent = NoRoot THEN TRUE ELSE rootState[parent] = "Published"
    /\ layerHead' = [layerHead EXCEPT ![layer] = root]
    /\ layerBase' = [layerBase EXCEPT ![layer] = NoRoot]
    /\ rootState' = [rootState EXCEPT ![root] = "Published"]
    /\ rootParent' = [rootParent EXCEPT ![root] = parent]
    /\ rootOwner' = [rootOwner EXCEPT ![root] = layer]
    /\ rootCommit' = [rootCommit EXCEPT ![root] = commitVersion + 1]
    \* The old layer pointer becomes the new root's parent edge, so its
    \* reference count is unchanged. The new head contributes one new ref.
    /\ rootRefCount' = [rootRefCount EXCEPT ![root] = 1]
    /\ postDeletePublish' =
           (postDeletePublish \/ layerState[layer] # "Active")
    /\ commitVersion' = commitVersion + 1
    /\ UNCHANGED <<
           layerState, snapshotRoot, snapshotUsed, gcState
       >>

CreateSnapshot(layer, snapshot) ==
    LET root == VisibleRoot(layer) IN
    /\ commitVersion < MaxCommits
    /\ layerState[layer] = "Active"
    /\ snapshot \notin snapshotUsed
    /\ root # NoRoot
    /\ rootState[root] = "Published"
    /\ snapshotRoot' = [snapshotRoot EXCEPT ![snapshot] = root]
    /\ snapshotUsed' = snapshotUsed \cup {snapshot}
    /\ rootRefCount' =
           [rootRefCount EXCEPT ![root] = @ + 1]
    /\ commitVersion' = commitVersion + 1
    /\ UNCHANGED <<
           layerState, layerHead, layerBase, rootState, rootParent,
           rootOwner, rootCommit, gcState, postDeletePublish
       >>

DeleteSnapshot(snapshot) ==
    LET root == snapshotRoot[snapshot] IN
    /\ commitVersion < MaxCommits
    /\ root # NoRoot
    /\ rootRefCount[root] > 0
    /\ snapshotRoot' = [snapshotRoot EXCEPT ![snapshot] = NoRoot]
    /\ rootRefCount' = [rootRefCount EXCEPT ![root] = @ - 1]
    /\ commitVersion' = commitVersion + 1
    /\ UNCHANGED <<
           layerState, layerHead, layerBase, rootState, rootParent,
           rootOwner, rootCommit, snapshotUsed, gcState,
           postDeletePublish
       >>

ForkLayer(source, child) ==
    LET root == VisibleRoot(source) IN
    /\ commitVersion < MaxCommits
    /\ layerState[source] = "Active"
    /\ layerState[child] = "Missing"
    /\ root # NoRoot
    /\ rootState[root] = "Published"
    /\ layerState' = [layerState EXCEPT ![child] = "Active"]
    /\ layerBase' = [layerBase EXCEPT ![child] = root]
    /\ rootRefCount' =
           IF Mutation = "ForkWithoutPin"
           THEN rootRefCount
           ELSE [rootRefCount EXCEPT ![root] = @ + 1]
    /\ commitVersion' = commitVersion + 1
    /\ UNCHANGED <<
           layerHead, rootState, rootParent, rootOwner, rootCommit,
           snapshotRoot, snapshotUsed, gcState, postDeletePublish
       >>

ReleaseMultiplier == IF Mutation = "RetryDoubleRelease" THEN 2 ELSE 1

DeleteLayer(layer) ==
    /\ commitVersion < MaxCommits
    /\ layerState[layer] = "Active"
    /\ layerState' = [layerState EXCEPT ![layer] = "Deleted"]
    /\ layerHead' = [layerHead EXCEPT ![layer] = NoRoot]
    /\ layerBase' = [layerBase EXCEPT ![layer] = NoRoot]
    /\ rootRefCount' =
           [root \in Roots |->
               rootRefCount[root] -
               ReleaseMultiplier *
               ((IF layerHead[layer] = root THEN 1 ELSE 0) +
                (IF layerBase[layer] = root THEN 1 ELSE 0))]
    /\ commitVersion' = commitVersion + 1
    /\ UNCHANGED <<
           rootState, rootParent, rootOwner, rootCommit,
           snapshotRoot, snapshotUsed, gcState, postDeletePublish
       >>

BeginGc(root) ==
    /\ commitVersion < MaxCommits
    /\ rootState[root] = "Published"
    /\ \/ rootRefCount[root] = 0
       \/ Mutation = "DeleteReferencedRoot"
    /\ rootState' = [rootState EXCEPT ![root] = "Deleting"]
    /\ gcState' =
           IF Mutation = "MissingGcOutbox"
           THEN gcState
           ELSE [gcState EXCEPT ![root] = "Pending"]
    /\ commitVersion' = commitVersion + 1
    /\ UNCHANGED <<
           layerState, layerHead, layerBase, rootParent, rootOwner,
           rootCommit, rootRefCount, snapshotRoot, snapshotUsed,
           postDeletePublish
       >>

CompleteGc(root) ==
    LET parent == rootParent[root] IN
    /\ commitVersion < MaxCommits
    /\ rootState[root] = "Deleting"
    /\ gcState[root] = "Pending"
    /\ rootRefCount[root] = 0
    /\ rootState' = [rootState EXCEPT ![root] = "Deleted"]
    /\ gcState' = [gcState EXCEPT ![root] = "Done"]
    /\ rootRefCount' =
           [candidate \in Roots |->
               IF parent # NoRoot /\ candidate = parent
               THEN rootRefCount[candidate] - 1
               ELSE rootRefCount[candidate]]
    /\ commitVersion' = commitVersion + 1
    /\ UNCHANGED <<
           layerState, layerHead, layerBase, rootParent, rootOwner,
           rootCommit, snapshotRoot, snapshotUsed, postDeletePublish
       >>

Next ==
    \/ \E layer \in Layers : CreateLayer(layer)
    \/ \E layer \in Layers, root \in Roots : PublishRoot(layer, root)
    \/ \E layer \in Layers, snapshot \in Snapshots :
           CreateSnapshot(layer, snapshot)
    \/ \E snapshot \in Snapshots : DeleteSnapshot(snapshot)
    \/ \E source \in Layers, child \in Layers : ForkLayer(source, child)
    \/ \E layer \in Layers : DeleteLayer(layer)
    \/ \E root \in Roots : BeginGc(root)
    \/ \E root \in Roots : CompleteGc(root)

Spec == Init /\ [][Next]_vars

TypeOK ==
    /\ commitVersion \in 0..MaxCommits
    /\ layerState \in [Layers -> LayerStates]
    /\ layerHead \in [Layers -> Roots \cup {NoRoot}]
    /\ layerBase \in [Layers -> Roots \cup {NoRoot}]
    /\ rootState \in [Roots -> RootStates]
    /\ rootParent \in [Roots -> Roots \cup {NoRoot}]
    /\ rootOwner \in [Roots -> Layers \cup {NoLayer}]
    /\ rootCommit \in [Roots -> 0..MaxCommits]
    /\ rootRefCount \in [Roots -> 0..MaxRefs]
    /\ snapshotRoot \in [Snapshots -> Roots \cup {NoRoot}]
    /\ snapshotUsed \subseteq Snapshots
    /\ gcState \in [Roots -> GcStates]
    /\ postDeletePublish \in BOOLEAN

RefCountsExact ==
    \A root \in Roots : rootRefCount[root] = ExpectedRefCount(root)

PointersReferencePublishedRoots ==
    /\ \A layer \in Layers :
           /\ IF layerHead[layer] = NoRoot
              THEN TRUE
              ELSE rootState[layerHead[layer]] = "Published"
           /\ IF layerBase[layer] = NoRoot
              THEN TRUE
              ELSE rootState[layerBase[layer]] = "Published"
           /\ ~ (layerHead[layer] # NoRoot /\ layerBase[layer] # NoRoot)
    /\ \A snapshot \in Snapshots :
           IF snapshotRoot[snapshot] = NoRoot
           THEN TRUE
           ELSE rootState[snapshotRoot[snapshot]] = "Published"
    /\ \A child \in Roots :
           IF /\ rootState[child] \in {"Published", "Deleting"}
              /\ rootParent[child] # NoRoot
           THEN rootState[rootParent[child]] = "Published"
           ELSE TRUE

NoReferencedRootIsDeleted ==
    \A root \in Roots :
        rootState[root] \in {"Deleting", "Deleted"}
        => rootRefCount[root] = 0

GcHasTransactionalOutbox ==
    \A root \in Roots :
        /\ (rootState[root] = "Deleting" => gcState[root] = "Pending")
        /\ (rootState[root] = "Deleted" => gcState[root] = "Done")

RootCommitOrder ==
    /\ \A left \in Roots, right \in Roots :
           /\ rootState[left] # "Missing"
           /\ rootState[right] # "Missing"
           /\ rootCommit[left] = rootCommit[right]
           => left = right
    /\ \A child \in Roots :
           IF /\ rootState[child] # "Missing"
              /\ rootParent[child] # NoRoot
           THEN rootCommit[rootParent[child]] < rootCommit[child]
           ELSE TRUE

NoPublishAfterDelete == ~postDeletePublish

Safety ==
    /\ TypeOK
    /\ RefCountsExact
    /\ PointersReferencePublishedRoots
    /\ NoReferencedRootIsDeleted
    /\ GcHasTransactionalOutbox
    /\ RootCommitOrder
    /\ NoPublishAfterDelete

=============================================================================
