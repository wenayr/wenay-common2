
export type ObjectKeyPath<TObject extends object=object, TValue=unknown> = readonly string[];

export function objectSetValueByPath<TObj extends {[key :string] :any}, TVal>
    (obj :TObj,  path :ObjectKeyPath<TObj,TVal>,  value :TVal)
    : void {
        if (path.length==0) throw "empty path!";
        let key= path[0];
        if (path.length==1) { (obj as any)[key]= value; return; }
        let val= obj[key];
        if (typeof val!="object") throw "value is not an object: "+val;
        return objectSetValueByPath(val, path.slice(1), value);
    }

export function objectGetValueByPath<TObj extends {readonly [key :string] :any}, TVal>
    (object :TObj,  path :ObjectKeyPath<TObj,TVal>)
    : TVal {
        if (path.length==0) throw "empty path!";
        let key= path[0];
        if (! (key in object)) throw "key is not in object: "+key;
        let val= object[key];
        if (path.length==1) return val;
        if (typeof val!="object") throw "value is not an object: "+val;
        return objectGetValueByPath(val, path.slice(1));
        //throw "key path is not found: "+JSON.stringify(path);
    }

export function objectDeleteValueByPath<TObj extends {readonly [key :string] :any}, TVal>
    (object :TObj,  path :ObjectKeyPath<TObj,TVal>)
    : boolean {
        if (path.length==0) throw "empty path!";
        let key= path[0];
        if (path.length==1)
            if (! (key in object)) return false;
            else { delete (object as any)[key]; return true; }
        let val= object[key];
        if (typeof val!="object") throw "value is not an object: "+val;
        return objectDeleteValueByPath(val, path.slice(1)) as boolean;
    }


export function* iterateDeepObjectEntries<TObj extends object> (obj :TObj, filter? : (key :string, value :unknown, path :ObjectKeyPath<TObj>)=>boolean, currentPath : ObjectKeyPath<TObj> = [])
 : Generator<[key :string, value :unknown, path :ObjectKeyPath<TObj>]> {
    if (obj) // пришлось делать такую проверку, т.к. иначе почему-то выскакивает ошибка obj==undefined при рекурсии
        for(let [key,val] of Object.entries(obj)) {
            let keyPath= currentPath.concat(key);
            if (filter?.(key, val, keyPath)==false) continue;
            yield [key, val, keyPath];
            if (typeof(val)=="object") yield *iterateDeepObjectEntries(val, filter, keyPath);
        }
}
