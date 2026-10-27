-------------------------- MODULE ProducerDemand --------------------------
EXTENDS Naturals, FiniteSets, TLC
CONSTANTS AllowExpired, CrossRefund
Consumers == {"healthy", "slow"}
Buckets == {"fast", "slow"}
VARIABLES visible, room, bucket, permits, valid, served, encoders, debt, bad
vars == <<visible, room, bucket, permits, valid, served, encoders, debt, bad>>
Init == /\ visible = Consumers /\ room = Consumers
        /\ bucket = [c \in Consumers |-> IF c = "healthy" THEN "fast" ELSE "slow"]
        /\ permits = {} /\ valid = {} /\ served = {} /\ encoders = {}
        /\ debt = [c \in Consumers |-> 1] /\ bad = FALSE
Eligible == {b \in Buckets : \E c \in visible \cap room : bucket[c] = b}
Plan == /\ permits' = Eligible /\ valid' = Buckets
        /\ UNCHANGED <<visible, room, bucket, served, encoders, debt, bad>>
Expire(b) == /\ b \in valid /\ valid' = valid \ {b}
             /\ UNCHANGED <<visible, room, bucket, permits, served, encoders, debt, bad>>
Produce(b) == /\ b \in permits /\ (AllowExpired \/ b \in valid)
              /\ served' = served \cup {c \in visible : bucket[c] = b}
              /\ encoders' = encoders \cup {b}
              /\ bad' = (bad \/ b \notin valid)
              /\ UNCHANGED <<visible, room, bucket, permits, valid, debt>>
SlowVisibility == /\ visible' = IF "slow" \in visible THEN visible \ {"slow"} ELSE visible \cup {"slow"}
                  /\ UNCHANGED <<room, bucket, permits, valid, served, encoders, debt, bad>>
SlowRoom == /\ room' = IF "slow" \in room THEN room \ {"slow"} ELSE room \cup {"slow"}
            /\ UNCHANGED <<visible, bucket, permits, valid, served, encoders, debt, bad>>
SwitchSlow == /\ bucket' = [bucket EXCEPT !["slow"] = IF @ = "fast" THEN "slow" ELSE "fast"]
              /\ UNCHANGED <<visible, room, permits, valid, served, encoders, debt, bad>>
ResetSlow == /\ debt' = IF CrossRefund THEN [c \in Consumers |-> 0] ELSE [debt EXCEPT !["slow"] = 0]
             /\ UNCHANGED <<visible, room, bucket, permits, valid, served, encoders, bad>>
Next == Plan \/ SlowVisibility \/ SlowRoom \/ SwitchSlow \/ ResetSlow
        \/ (\E b \in Buckets : Expire(b) \/ Produce(b))
Spec == Init /\ [][Next]_vars /\ SF_vars(Plan) /\ SF_vars(Produce("fast"))
TypeOK == /\ visible \subseteq Consumers /\ room \subseteq Consumers
          /\ bucket \in [Consumers -> Buckets] /\ permits \subseteq Buckets
          /\ valid \subseteq Buckets /\ encoders \subseteq Buckets /\ served \subseteq Consumers
          /\ debt \in [Consumers -> 0..1] /\ bad \in BOOLEAN
NoExpiredProduction == ~bad
HealthyCreditIsolation == debt["healthy"] = 1
TwoEncoders == Cardinality(encoders) <= 2
HealthyProgress == <> ("healthy" \in served)
=============================================================================
