# Future Direct BLE Peer Experiment

Direct XRP-to-XRP BLE is not implemented or claimed. The production path is robot → laptop router →
robot. A future isolated experiment may investigate an XRP acting simultaneously as laptop-facing BLE
peripheral and peer-facing central/client, or using broadcaster/observer roles for very small events.

Physical firmware questions that must be answered first:

- Does the current MicroPython build expose usable central APIs?
- Can peripheral and central roles coexist without disrupting BLE REPL or dedicated DATA service?
- How many simultaneous connections are stable?
- Does the Radio Module firmware support the required roles and scheduling?
- What are latency, packet loss, memory overhead, and reconnect behavior?
- Can motor control and Red Vision remain stable concurrently?
- How are identity, loop prevention, TTL, security, and recovery handled without the coordinator?

Only after these tests should a `RobotTransport` implementation be prototyped. The envelope and topic
codecs can remain unchanged, but direct transport must not become a dependency of the centralized
working system.

