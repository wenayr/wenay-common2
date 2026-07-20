
export type ObjectKeyPath<TObject extends object=object, TValue=unknown> = readonly string[];

/** @deprecated use {@link objectSet} */
export function objectSetValueByPath<TObj extends {[key :string] :any}, TVal>
    (obj :TObj,  path :ObjectKeyPath<TObj,TVal>,  value :TVal)
    : void {
        if (path.length==0) throw "empty path!";
        let key= path[0];
        if (path.length==1) { (obj as any)[key]= value; return; }
        let val= obj[key];
        if (val == null || typeof val!="object") throw "value is not an object: "+val;
        return objectSetValueByPath(val, path.slice(1), value);
    }

// path is a string[] (NOT a dotted 'a.b.c'); throws if an intermediate segment isn't an object (lodash auto-creates)
export const objectSet= objectSetValueByPath

/** @deprecated use {@link objectGet} */
export function objectGetValueByPath<TObj extends {readonly [key :string] :any}, TVal>
    (object :TObj,  path :ObjectKeyPath<TObj,TVal>)
    : TVal {
        if (path.length==0) throw "empty path!";
        let key= path[0];
        if (! (key in object)) throw "key is not in object: "+key;
        let val= object[key];
        if (path.length==1) return val;
        if (val == null || typeof val!="object") throw "value is not an object: "+val;
        return objectGetValueByPath(val, path.slice(1));
        //throw "key path is not found: "+JSON.stringify(path);
    }

// path is a string[]; THROWS on a missing/non-object segment (lodash get returns undefined)
export const objectGet= objectGetValueByPath

/** @deprecated use {@link objectUnset} */
export function objectDeleteValueByPath<TObj extends {readonly [key :string] :any}, TVal>
    (object :TObj,  path :ObjectKeyPath<TObj,TVal>)
    : boolean {
        if (path.length==0) throw "empty path!";
        let key= path[0];
        if (path.length==1)
            if (! (key in object)) return false;
            else { delete (object as any)[key]; return true; }
        let val= object[key];
        if (val == null || typeof val!="object") throw "value is not an object: "+val;
        return objectDeleteValueByPath(val, path.slice(1)) as boolean;
    }

// returns boolean (matches lodash unset)
export const objectUnset= objectDeleteValueByPath


/** @deprecated use {@link deepEntries} */
export function* iterateDeepObjectEntries<TObj extends object> (obj :TObj, filter? : (key :string, value :unknown, path :ObjectKeyPath<TObj>)=>boolean, currentPath : ObjectKeyPath<TObj> = [])
 : Generator<[key :string, value :unknown, path :ObjectKeyPath<TObj>]> {
    if (obj) // had to do this check, otherwise somehow obj==undefined error pops up during recursion
        for(let [key,val] of Object.entries(obj)) {
            let keyPath= currentPath.concat(key);
            if (filter?.(key, val, keyPath)==false) continue;
            yield [key, val, keyPath];
            if (typeof(val)=="object") yield *iterateDeepObjectEntries(val, filter, keyPath);
        }
}

// recursive Object.entries; yields [key, value, path]
export const deepEntries= iterateDeepObjectEntries
