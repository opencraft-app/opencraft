--------------------- MODULE CatalogCollaboration ---------------------
EXTENDS Integers, FiniteSets, TLC
CONSTANTS Clients, MaxCommits, LocalOnly, UnsafeRetiredResponse, LastArrivalWins
VARIABLES revision, views, known, published, required, queue, allowed, online, fences, reads, stable
vars == <<revision, views, known, published, required, queue, allowed, online, fences, reads, stable>>
EmptyRead == [active |-> FALSE, fence |-> 0, cut |-> 0]
Init == /\ revision = 0 /\ views = [c \in Clients |-> 0] /\ known = [c \in Clients |-> 0]
        /\ published = [c \in Clients |-> 0] /\ required = [c \in Clients |-> 0] /\ queue = [c \in Clients |-> {}]
        /\ allowed = Clients /\ online = Clients /\ fences = [c \in Clients |-> 0]
        /\ reads = [c \in Clients |-> EmptyRead] /\ stable = FALSE
Commit(c) == /\ ~stable /\ c \in allowed \cap online /\ revision < MaxCommits
  /\ revision' = revision + 1
  /\ LET eligible == allowed \cap online
         recipients == IF LocalOnly THEN {c} ELSE eligible
     IN /\ required' = [d \in Clients |-> IF d \in eligible THEN revision' ELSE required[d]]
        /\ published' = [d \in Clients |-> IF d \in recipients THEN revision' ELSE published[d]]
        /\ queue' = [d \in Clients |-> IF d \in recipients THEN queue[d] \cup {revision'} ELSE queue[d]]
  /\ views' = [views EXCEPT ![c] = revision'] /\ known' = [known EXCEPT ![c] = revision']
  /\ UNCHANGED <<allowed, online, fences, reads, stable>>
Deliver(c) == /\ c \in allowed \cap online /\ queue[c] # {}
  /\ \E r \in queue[c]:
       /\ views' = [views EXCEPT ![c] = IF LastArrivalWins THEN r ELSE IF r > @ THEN r ELSE @]
       /\ known' = [known EXCEPT ![c] = IF r > @ THEN r ELSE @]
       /\ queue' = [queue EXCEPT ![c] = @ \ {r}]
  /\ UNCHANGED <<revision, published, required, allowed, online, fences, reads, stable>>
Drop(c) == /\ queue[c] # {} /\ queue' = [queue EXCEPT ![c] = {}]
  /\ UNCHANGED <<revision, views, known, published, required, allowed, online, fences, reads, stable>>
ReadStart(c) == /\ ~stable /\ c \in allowed \cap online /\ ~reads[c].active
  /\ \E r \in 0..revision: reads' = [reads EXCEPT ![c] = [active |-> TRUE, fence |-> fences[c], cut |-> r]]
  /\ UNCHANGED <<revision, views, known, published, required, queue, allowed, online, fences, stable>>
ReadDeliver(c) == /\ reads[c].active
  /\ LET admit == (c \in allowed /\ reads[c].fence = fences[c]) \/ UnsafeRetiredResponse
         r == reads[c].cut
     IN /\ views' = [views EXCEPT ![c] = IF admit THEN IF LastArrivalWins THEN r ELSE IF r > @ THEN r ELSE @ ELSE @]
        /\ known' = [known EXCEPT ![c] = IF admit /\ r > @ THEN r ELSE @]
  /\ reads' = [reads EXCEPT ![c] = EmptyRead]
  /\ UNCHANGED <<revision, published, required, queue, allowed, online, fences, stable>>
Cut(c) == /\ ~stable /\ c \in online /\ online' = online \ {c}
  /\ UNCHANGED <<revision, views, known, published, required, queue, allowed, fences, reads, stable>>
Revoke(c) == /\ ~stable /\ c \in allowed /\ fences[c] = 0
  /\ allowed' = allowed \ {c} /\ fences' = [fences EXCEPT ![c] = 1]
  /\ views' = [views EXCEPT ![c] = -1] /\ known' = [known EXCEPT ![c] = -1]
  /\ queue' = [queue EXCEPT ![c] = {}]
  /\ UNCHANGED <<revision, published, required, online, reads, stable>>
Quiesce == /\ ~stable /\ stable' = TRUE /\ online' = Clients
  /\ UNCHANGED <<revision, views, known, published, required, queue, allowed, fences, reads>>
Converged == \A c \in allowed: views[c] = revision
Refresh(c) == /\ stable /\ c \in allowed \cap online /\ views[c] # revision
  /\ views' = [views EXCEPT ![c] = revision] /\ known' = [known EXCEPT ![c] = revision]
  /\ UNCHANGED <<revision, published, required, queue, allowed, online, fences, reads, stable>>
Next == (\E c \in Clients: Commit(c) \/ Deliver(c) \/ Drop(c) \/ ReadStart(c) \/ ReadDeliver(c) \/ Cut(c) \/ Revoke(c) \/ Refresh(c)) \/ Quiesce
Spec == Init /\ [][Next]_vars /\ WF_vars(Quiesce) /\ (\A c \in Clients: WF_vars(Refresh(c)))
TypeOK == /\ revision \in 0..MaxCommits /\ views \in [Clients -> -1..MaxCommits]
          /\ known \in [Clients -> -1..MaxCommits] /\ required \in [Clients -> 0..MaxCommits] /\ published \in [Clients -> 0..MaxCommits]
          /\ allowed \subseteq Clients /\ online \subseteq Clients
BroadcastCoverage == \A c \in allowed: published[c] >= required[c]
NoRegression == \A c \in allowed: views[c] >= known[c]
NoRevokedDisplay == \A c \in Clients \ allowed: views[c] = -1
EventuallyConverged == <>[]Converged
=============================================================================
