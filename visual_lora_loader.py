import folder_paths
import json
import os
import hashlib
import requests
from datetime import datetime
from nodes import LoraLoader
from server import PromptServer
from aiohttp import web
import logging
import threading

CIVITAI_API_BASE = "https://civitai.com/api/v1"
# On stocke le cache dans le dossier utilisateur de ComfyUI (comme rgthree)
# Ex: ComfyUI/user/nomad/neurad_cache/
CACHE_DIR = os.path.join(folder_paths.user_directory, "neurad_cache")
if not os.path.exists(CACHE_DIR):
    os.makedirs(CACHE_DIR)

class VisualLoraLoaderNode:
    @classmethod
    def INPUT_TYPES(s):
        return {
            "required": {
                "model": ("MODEL",),
                "clip": ("CLIP",),
                "lora_data": ("STRING", {"default": "[]", "multiline": False, "hidden": True}),
            }
        }
    RETURN_TYPES = ("MODEL", "CLIP", "STRING")
    RETURN_NAMES = ("MODEL", "CLIP", "active_loras_info")
    FUNCTION = "load_lora"
    CATEGORY = "loaders"

    def load_lora(self, model, clip, lora_data):
        try: active_loras = json.loads(lora_data)
        except: return (model, clip, "Error")
        current_model, current_clip = model, clip
        lora_loader_instance = LoraLoader()
        applied_info = []
        for lora in active_loras:
            lora_name = lora.get("name")
            strength_model = float(lora.get("strength_model", 1.0))
            strength_clip = float(lora.get("strength_clip", strength_model))
            subfolder = lora.get("subfolder", "")
            full_name = f"{subfolder.replace('\\', '/')}/{lora_name.replace('\\', '/')}".replace("//", "/").strip("/")
            path = folder_paths.get_full_path("loras", full_name) or folder_paths.get_full_path("loras", lora_name)
            if path:
                try:
                    current_model, current_clip = lora_loader_instance.load_lora(current_model, current_clip, full_name, strength_model, strength_clip)
                    applied_info.append(f"{full_name} ({strength_model})")
                except Exception as e: logging.error(f"[Neurad] Load error: {e}")
        return (current_model, current_clip, ", ".join(applied_info))

@PromptServer.instance.routes.post("/neurad/reset-cache")
async def reset_cache(request):
    """
    PURGE TOTALE : Supprime le fichier de backup ET tous les fichiers de cache par hash.
    """
    try:
        # 1. Supprimer le backup LocalStorage
        backup_path = os.path.join(CACHE_DIR, "localStorage_backup.json")
        if os.path.exists(backup_path):
            os.remove(backup_path)
            logging.info("[Neurad] Backup file deleted.")

        # 2. Supprimer TOUS les fichiers de cache .json (sauf le backup qu'on vient de traiter)
        # On liste tous les fichiers dans le dossier de cache
        for filename in os.listdir(CACHE_DIR):
            if filename.endswith(".json") and filename != "localStorage_backup.json":
                file_path = os.path.join(CACHE_DIR, filename)
                try:
                    os.remove(file_path)
                except Exception as e:
                    logging.warning(f"[Neurad] Could not delete cache file {filename}: {e}")
        
        # 3. CRÉER LE DRAPEAU DE PURGE (Fichier vide)
        flag_path = os.path.join(CACHE_DIR, "purge_flag.lock")
        with open(flag_path, 'w') as f:
            f.write("purged") # Ou laisser vide
            
        logging.info("[Neurad] Full cache purge completed.")
        return web.json_response({"success": True, "message": "Cache purged"})
    except Exception as e:
        logging.error(f"[Neurad] Critical purge error: {e}")
        return web.json_response({"error": str(e)}, status=500)

def get_sha256_hash(file_path):
    """Calcule le hash SHA256 du fichier (comme rgthree)."""
    if not os.path.exists(file_path): return None
    sha256_hash = hashlib.sha256()
    with open(file_path, "rb") as f:
        for byte_block in iter(lambda: f.read(4096), b""):
            sha256_hash.update(byte_block)
    return sha256_hash.hexdigest()

def get_cache_file_path(file_hash):
    return os.path.join(CACHE_DIR, f"{file_hash}.json")

def load_from_cache(file_hash):
    cache_path = get_cache_file_path(file_hash)
    if os.path.exists(cache_path):
        try:
            with open(cache_path, 'r', encoding='utf-8') as f:
                data = json.load(f)
                # Vérifier si le cache est trop vieux (optionnel, ici 24h)
                # if datetime.now().timestamp() - data.get('timestamp', 0) < 86400: 
                return data.get('response')
        except: pass
    return None
    
def has_cache_for_file(file_path):
    """Vérifie simplement si un fichier de cache existe pour ce fichier .safetensors."""
    file_hash = get_sha256_hash(file_path)
    if not file_hash:
        return False
    cache_path = get_cache_file_path(file_hash)
    return os.path.exists(cache_path)

def save_to_cache(file_hash, data):
    cache_path = get_cache_file_path(file_hash)
    try:
        with open(cache_path, 'w', encoding='utf-8') as f:
            json.dump({'timestamp': datetime.now().timestamp(), 'response': data}, f, indent=2)
    except Exception as e:
        logging.warning(f"[Neurad] Cache write error (non-critical): {e}")

def fetch_civitai_by_hash(file_hash):
    """Appelle l'API Civitai par HASH (la méthode magique de rgthree)."""
    url = f"{CIVITAI_API_BASE}/model-versions/by-hash/{file_hash}"
    try:
        response = requests.get(url, timeout=10)
        if response.status_code == 200:
            data = response.json()
            # Vérifier que c'est bien un modèle (parfois le hash ne correspond à rien)
            if data and 'model' in data:
                return data
        elif response.status_code == 404:
            logging.info(f"[Neurad] No model found for hash {file_hash}")
        else:
            logging.warning(f"[Neurad] API Error {response.status_code} for hash {file_hash}")
    except Exception as e:
        logging.warning(f"[Neurad] Request failed: {e}")
    return None

def parse_civitai_response(data):
    """Formate la réponse Civitai pour notre frontend."""
    if not data:
        return None
    
    # 1. Extraction ROBUSTE de l'ID du MODÈLE (pas la version)
    model_id = None
    
    # Priorité 1: Le champ 'modelId' explicite (souvent à la racine pour cette API)
    if 'modelId' in data:
        model_id = data.get('modelId')
    
    # Priorité 2: L'objet 'model' imbriqué
    if not model_id and 'model' in data and isinstance(data['model'], dict):
        model_id = data['model'].get('id')
    
    # Priorité 3: Fallback sur 'id' si on pense que c'est le modèle (rare pour by-hash)
    # Mais attention, si on n'a que l'ID de version, on doit le gérer différemment pour l'URL
    version_id = data.get('id') 
    
    if not model_id and version_id:
        # Si on n'a trouvé que l'ID de version, on essaie de voir si 'model' existe quand même
        # Sinon, on devra construire l'URL avec l'ID de version en paramètre
        pass

    # 2. Construction de l'URL CORRECTE
    civitai_url = "https://civitai.com/models"
    
    if model_id:
        civitai_url += f"/{model_id}"
        # Si on a aussi un ID de version différent, on l'ajoute en paramètre pour tomber sur la bonne version
        if version_id and version_id != model_id:
            civitai_url += f"?modelVersionId={version_id}"
    elif version_id:
        # Cas rare : on n'a que l'ID de version, on tente l'URL directe (ça redirige souvent)
        # Mais c'est mieux d'avoir le modelId. Si on est ici, c'est qu'on n'a pas trouvé le modelId.
        # On laisse l'URL de base ou on tente avec l'ID de version (moins fiable)
        civitai_url += f"/{version_id}" # Risqué, mais mieux que None

    # 3. Nom
    model_name = ""
    if 'model' in data and isinstance(data['model'], dict):
        model_name = data['model'].get('name', '')
    
    version_name = data.get('name', '')
    full_name = model_name
    if version_name and model_name and version_name != model_name:
        full_name += f" - {version_name}"
    elif not model_name:
        full_name = version_name

    # 4. Images
    images = []
    # 4. Images (Toutes les images, sans limite)
    images = []
    if 'images' in data:
        for img in data['images']: 
            meta_data = img.get('meta', {})
            if isinstance(meta_data, str):
                try: meta_data = json.loads(meta_data)
                except: meta_data = {}
            
            images.append({
                "url": img.get('url'),
                "nsfwLevel": img.get('nsfwLevel', 0),
                "width": img.get('width'),
                "height": img.get('height'),
                "positive": meta_data.get('prompt', '') if meta_data else ""
            })

    return {
        "source": "civitai_hash",
        "model_id": model_id if model_id else version_id,
        "name": full_name,
        "trainedWords": (data.get('trainedWords', []) or []) + (data.get('triggerWords', []) or []),
        "images": images,
        "strengthMin": None,
        "strengthMax": None,
        "civitaiUrl": civitai_url
    }

@PromptServer.instance.routes.get("/neurad/get-loras")
async def get_loras(request):
    """
    LISTE ULTRA-RAPIDE.
    Ne calcule AUCUN hash, ne lit AUCUN cache.
    Renvoie has_meta: False pour tout le monde.
    C'est le JS (LocalStorage) qui gère l'affichage des icônes déjà connues.
    """
    lora_folders = folder_paths.get_folder_paths("loras")
    all_loras = []
    
    for root_folder in lora_folders:
        if not os.path.exists(root_folder): continue
        for root, dirs, files in os.walk(root_folder):
            for filename in files:
                if filename.endswith(".safetensors"):
                    try: 
                        rel_path = os.path.relpath(os.path.join(root, filename), root_folder)
                    except: 
                        rel_path = filename
                    
                    all_loras.append({
                        "name": filename, 
                        "display_name": os.path.splitext(filename)[0],
                        "relative_path": rel_path, 
                        "subfolder": os.path.dirname(rel_path),
                        "has_meta": False,  # Toujours faux ici pour la vitesse
                        "meta": {}          # Vide
                    })
    
    all_loras.sort(key=lambda x: (x["subfolder"], x["display_name"].lower()))
    return web.json_response(all_loras)
    
@PromptServer.instance.routes.post("/neurad/fetch-single-info")
async def fetch_single_info(request):
    """
    SECURED: Confines path resolution to allowed lora folders using realpath + commonpath.
    """
    try:
        data = await request.json()
        rel_path = data.get("path")
        
        if not rel_path:
            return web.json_response({"error": "No path provided"}, status=400)

        # Security Fix: Normalize the input path to prevent traversal tricks early
        # os.path.normpath collapses '..' and '.' but doesn't resolve symlinks yet
        clean_rel_path = os.path.normpath(rel_path)
        
        # Reject absolute paths immediately as we expect a relative path from the client
        if os.path.isabs(clean_rel_path):
            return web.json_response({"error": "Absolute paths are not allowed"}, status=400)

        full_path = None
        lora_folders = folder_paths.get_folder_paths("loras")
        
        for root in lora_folders:
            if not os.path.exists(root):
                continue
                
            # Construct the candidate path
            candidate_path = os.path.join(root, clean_rel_path)
            
            # Resolve to absolute real path (resolves symlinks and '..')
            # If the file doesn't exist, realpath still resolves the directory structure up to the last existing component,
            # but for strict security, we usually want to ensure the target exists and is within bounds.
            if not os.path.exists(candidate_path):
                continue
                
            real_candidate = os.path.realpath(candidate_path)
            real_root = os.path.realpath(root)
            
            # Ensure the resolved path starts with the resolved root directory
            # We add os.sep to prevent matching partial folder names (e.g. /loras vs /loras_private)
            if real_candidate.startswith(real_root + os.sep) or real_candidate == real_root:
                # Additional check: ensure it's a file, not a directory
                if os.path.isfile(real_candidate):
                    full_path = real_candidate
                    break
            else:
                # Path escapes the root directory
                logging.warning(f"[Neurad] Blocked path traversal attempt: {rel_path} resolved to {real_candidate}")
                continue

        if not full_path:
            return web.json_response({"error": "File not found or access denied"}, status=404)

        # 1. Calcul du Hash
        file_hash = get_sha256_hash(full_path)
        if not file_hash:
            return web.json_response({"error": "Could not calculate hash"}, status=500)

        # 2. Vérifier le cache local
        cached_data = load_from_cache(file_hash)
        if cached_data:
            parsed = parse_civitai_response(cached_data)
            if parsed:
                return web.json_response({"success": True, "meta": parsed})

        # 3. Fetch API par Hash
        raw_data = fetch_civitai_by_hash(file_hash)
        if not raw_data:
            return web.json_response({"success": False, "error": "No model found on Civitai for this file hash"}, status=404)

        # 4. Parser et Sauvegarder
        parsed = parse_civitai_response(raw_data)
        if parsed:
            save_to_cache(file_hash, raw_data)
            return web.json_response({"success": True, "meta": parsed})
        
        return web.json_response({"success": False, "error": "Data parsing failed"}, status=500)

    except Exception as e:
        logging.error(f"[Neurad] Critical Error: {e}")
        return web.json_response({"error": str(e)}, status=500)

@PromptServer.instance.routes.post("/neurad/save-localstorage-backup")
async def save_backup(request):
    """Reçoit les données du JS et les sauvegarde sur le disque dur."""
    try:
        data = await request.json()
        backup_path = os.path.join(CACHE_DIR, "localStorage_backup.json")
        with open(backup_path, 'w', encoding='utf-8') as f:
            json.dump(data, f, indent=2)
        logging.info("[Neurad] LocalStorage backup saved to disk.")
        return web.json_response({"success": True})
    except Exception as e:
        logging.error(f"[Neurad] Backup save error: {e}")
        return web.json_response({"error": str(e)}, status=500)
        
@PromptServer.instance.routes.post("/neurad/update-lora-info")
async def update_lora_info(request):
    """
    Reçoit les données modifiées par l'utilisateur et met à jour le fichier de cache JSON correspondant.
    """
    try:
        data = await request.json()
        lora_path = data.get("path") # Le chemin relatif unique (ex: "subfolder/model.safetensors")
        updated_meta = data.get("meta") # Les nouvelles données (nom, triggers, etc.)

        if not lora_path or not updated_meta:
            return web.json_response({"error": "Missing path or meta data"}, status=400)
        
        backup_path = os.path.join(CACHE_DIR, "localStorage_backup.json")
        backup_data = {}
        
        if os.path.exists(backup_path):
            try:
                with open(backup_path, 'r', encoding='utf-8') as f:
                    backup_data = json.load(f)
            except:
                backup_data = {}

        # Mise à jour des données pour cette LoRA
        backup_data[lora_path] = updated_meta
        
        # Ajout d'un flag pour indiquer que c'est édité manuellement (optionnel mais utile)
        backup_data[lora_path]['edited_by_user'] = True

        # Sauvegarde sur le disque
        with open(backup_path, 'w', encoding='utf-8') as f:
            json.dump(backup_data, f, indent=2, ensure_ascii=False)

        logging.info(f"[Neurad] Updated manual data for: {lora_path}")
        return web.json_response({"success": True})

    except Exception as e:
        logging.error(f"[Neurad] Update error: {e}")
        return web.json_response({"error": str(e)}, status=500)

@PromptServer.instance.routes.get("/neurad/load-localstorage-backup")
async def load_backup(request):
    """Renvoie les données sauvegardées sur le disque pour restaurer le JS."""
    try:
        flag_path = os.path.join(CACHE_DIR, "purge_flag.lock")
        
        # SI LE DRAPEAU EXISTE : On bloque la restauration et on nettoie le drapeau
        if os.path.exists(flag_path):
            try:
                os.remove(flag_path)
                logging.info("[Neurad] Purge flag detected. Blocking restoration to ensure clean state.")
            except:
                pass
            # On renvoie des données vides, peu importe si le backup existe
            return web.json_response({"success": False, "data": {}, "blocked_by_purge": True})
            
        backup_path = os.path.join(CACHE_DIR, "localStorage_backup.json")
        if os.path.exists(backup_path):
            # Vérification de sécurité : si le fichier est vide ou corrompu, on ne restaure rien
            try:
                with open(backup_path, 'r', encoding='utf-8') as f:
                    data = json.load(f)
                # On ne restaure que si c'est un dictionnaire non vide
                if isinstance(data, dict) and len(data) > 0:
                    return web.json_response({"success": True, "data": data})
                else:
                    # Fichier vide ou invalide, on considère qu'il n'y a rien à restaurer
                    return web.json_response({"success": False, "data": {}})
            except json.JSONDecodeError:
                logging.warning("[Neurad] Backup file corrupted, ignoring.")
                return web.json_response({"success": False, "data": {}})
        else:
            return web.json_response({"success": False, "data": {}})
    except Exception as e:
        logging.error(f"[Neurad] Backup load error: {e}")
        return web.json_response({"error": str(e)}, status=500)

NODE_CLASS_MAPPINGS = {"NeuradVisualLora": VisualLoraLoaderNode}
NODE_DISPLAY_NAME_MAPPINGS = {"NeuradVisualLora": "Visual LoRA Loader - Neurad"}