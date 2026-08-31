# S2 Actual cluster supervision

The two S2 Sparks run the same static-cluster service. The launcher preserves
the existing IPv4 fabric preload, four-request admission limit, cluster ports,
and assignment helper while keeping `actual-daemon` in the systemd foreground.
The node holding `10.44.0.11` is the configured leader and automatically loads
`qwen3.8-27b-Q4_K_M` once membership is joined; the worker joins without
separately loading the model. The loader waits for structured Actual status and
does not infer readiness from memory use.
`Restart=always` recovers peer-loss exits and intentional exits used to apply a
nightly update.

The `somewheresystems` account has systemd lingering enabled on both Sparks, so
the user unit starts at boot and does not depend on an interactive SSH session.
Install on each Spark from this directory as that account:

```sh
./install-actual-spark-cluster.sh
./check-actual-spark-cluster.sh
```

The installer backs up the prior unit and launchers under
`~/.actual/service-backups/`, disables any incompatible standalone user unit,
removes the legacy boot-only cron launcher, and enables the persistent user
unit `actual-spark-cluster.service`.

After both services are active, load the intended model through the leader and
verify `actual status --format json` on both nodes. Terminate the leader daemon
once and confirm systemd assigns a new PID after the 15-second restart delay.
