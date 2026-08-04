# Update an Existing ISSAS/SAM2 Environment

Use this guide if the old desktop ISSAS already works in your `sam2` Conda
environment. You do not need to create another environment unless the update
fails.

## 1. Update SAM2

~~~bash
conda activate sam2
cd /path/to/sam2
git pull
python -m pip uninstall -y SAM-2
python -m pip install -e .
~~~

The reinstall is recommended by the official SAM2 project when moving from an
older SAM2 release to the current SAM2.1 code.

## 2. Download or refresh the checkpoints

~~~bash
cd checkpoints
bash download_ckpts.sh
cd ..
~~~

## 3. Add ISSAS Web

From the SAM2 root folder:

~~~bash
git clone https://github.com/mqxwd68/ISSAS_Web.git
cd ISSAS_Web
python -m pip install --upgrade -r requirements-web.txt
~~~

If `ISSAS_Web` is already cloned, update it instead:

~~~bash
cd /path/to/sam2/ISSAS_Web
git pull
python -m pip install --upgrade -r requirements-web.txt
~~~

## 4. Check the environment

~~~bash
python -c "import torch, sam2, fastapi; print('PyTorch:', torch.__version__); print('CUDA:', torch.cuda.is_available()); print('MPS:', torch.backends.mps.is_available())"
~~~

Current SAM2 requires Python 3.10 or newer, PyTorch 2.5.1 or newer, and
TorchVision 0.20.1 or newer. If the update fails because the existing environment
is too old or has incompatible packages, use the fresh installation in
[README.md](README.md) with Python 3.11.

## 5. Run

~~~bash
cd /path/to/sam2/ISSAS_Web
export SAM2_CHECKPOINT=../checkpoints/sam2.1_hiera_large.pt
python server.py
~~~

Open <http://127.0.0.1:9010>.

The old `ISSAS/` and new `ISSAS_Web/` folders can remain beside each other in
the same SAM2 root folder.
