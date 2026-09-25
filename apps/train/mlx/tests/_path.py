"""Make apps/train/mlx importable from the tests, and locate the shared fixtures."""
import os
import sys

MLX_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
REPO_ROOT = os.path.dirname(os.path.dirname(os.path.dirname(MLX_DIR)))
PARITY_FIXTURES = os.path.join(REPO_ROOT, "apps", "parity", "test", "fixtures")

if MLX_DIR not in sys.path:
    sys.path.insert(0, MLX_DIR)
