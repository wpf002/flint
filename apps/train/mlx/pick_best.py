#!/usr/bin/env python3
"""Early-stopping by checkpoint selection: parse a training log for the lowest
val loss, then make that checkpoint the active adapter (avoids the overfit we saw
when training ran too long on a small corpus)."""
import sys, re, os, glob, shutil

trainlog, adapter_dir = sys.argv[1], sys.argv[2]
best_iter, best_loss = None, 1e9
for line in open(trainlog):
    m = re.search(r"Iter (\d+): Val loss ([\d.]+)", line)
    if m:
        it, loss = int(m.group(1)), float(m.group(2))
        if loss < best_loss:
            best_loss, best_iter = loss, it

if best_iter is None:
    print("pick_best: no val checkpoints found; keeping final adapter")
    sys.exit(0)

ckpts = {}
for p in glob.glob(os.path.join(adapter_dir, "*_adapters.safetensors")):
    m = re.search(r"(\d+)_adapters", os.path.basename(p))
    if m:
        ckpts[int(m.group(1))] = p

if not ckpts:
    print(f"pick_best: best val {best_loss:.3f} @ iter {best_iter}, but no numbered checkpoints; keeping final")
    sys.exit(0)

chosen = min(ckpts.keys(), key=lambda k: abs(k - best_iter))
dst = os.path.join(adapter_dir, "adapters.safetensors")
shutil.copy(ckpts[chosen], dst)
print(f"pick_best: best val loss {best_loss:.3f} @ iter {best_iter} -> active adapter = checkpoint {chosen}")
